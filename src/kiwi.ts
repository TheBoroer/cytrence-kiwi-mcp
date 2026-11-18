import type { KiwiConfig } from "./config.js";
import { type KeyChord, parseChord, textToKeystrokes } from "./keys.js";
import { KiwiLink, sleep } from "./link.js";
import {
  ABS_MAX,
  MouseButton,
  MsgType,
  absoluteMouseReport,
  keyboardReport,
} from "./protocol.js";
import { type FrameArea, type Snapshot, VideoCapture } from "./video.js";

export type ButtonName = "left" | "right" | "middle" | "back" | "forward";
export type ScrollDirection = "up" | "down" | "left" | "right";

const BUTTONS: Record<ButtonName, number> = {
  left: MouseButton.Left,
  right: MouseButton.Right,
  middle: MouseButton.Middle,
  back: MouseButton.Back,
  forward: MouseButton.Forward,
};

/** Gaps between HID reports. The Kiwi forwards each frame as a USB HID report, so back-to-back frames need a little room. */
const HOVER_MS = 40;
const CLICK_HOLD_MS = 60;
const MULTI_CLICK_GAP_MS = 80;
const SCROLL_STEP_MS = 25;

export const MAX_TEXT_LENGTH = 5000;

/** [pan, wheel] per notch, HID convention (no natural scrolling). */
const SCROLL_VECTORS: Record<ScrollDirection, [number, number]> = {
  up: [0, 1],
  down: [0, -1],
  left: [-1, 0],
  right: [1, 0],
};

export interface ScreenSize {
  width: number;
  height: number;
}

/**
 * Maps a fraction of the video frame (0..1) to the Kiwi's 0..32767 absolute range.
 * The target's absolute range spans only its picture, so `area` (where the picture sits
 * between any black bars) is stretched over it. Points on a bar land on the picture's edge.
 */
function fractionToAbs(fx: number, fy: number, area: Readonly<FrameArea>): { x: number; y: number } {
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) throw new Error("Coordinates must be numbers");
  const scale = (f: number, start: number, size: number) =>
    Math.min(ABS_MAX, Math.max(0, Math.floor(((f - start) / size) * (ABS_MAX + 1))));
  return { x: scale(fx, area.x, area.width), y: scale(fy, area.y, area.height) };
}

/**
 * High-level control of the target computer: screenshots plus mouse and keyboard
 * gestures. Mouse coordinates are pixels in the screenshot's coordinate space.
 */
export class Kiwi {
  readonly link: KiwiLink;
  readonly video: VideoCapture;
  private screen: ScreenSize;
  /** Last absolute position sent (0..32767), so scrolls and clicks without coordinates stay put. */
  private abs: { x: number; y: number } | undefined;

  constructor(private readonly config: KiwiConfig) {
    this.link = new KiwiLink({ path: config.serialPort, baudRate: config.baudRate, idleCloseMs: config.serialIdleMs });
    this.video = new VideoCapture({
      ffmpegPath: config.ffmpegPath,
      device: config.videoDevice,
      captureSize: config.captureSize,
      outputWidth: config.screenshotWidth,
      idleStopMs: config.videoIdleMs,
      streamFps: config.streamFps,
      detectBars: config.detectBars,
    });
    const [cw, ch] = config.captureSize.split("x").map(Number);
    const aspect = cw && ch ? ch / cw : 9 / 16;
    this.screen = { width: config.screenshotWidth, height: Math.round((config.screenshotWidth * aspect) / 2) * 2 };
  }

  get screenSize(): ScreenSize {
    return { ...this.screen };
  }

  get cursor(): { x: number; y: number } | undefined {
    if (!this.abs) return undefined;
    const area = this.video.activeArea;
    const toPixel = (abs: number, start: number, size: number, pixels: number) =>
      Math.round((start + (abs / (ABS_MAX + 1)) * size) * pixels - 0.5);
    return {
      x: toPixel(this.abs.x, area.x, area.width, this.screen.width),
      y: toPixel(this.abs.y, area.y, area.height, this.screen.height),
    };
  }

  async screenshot(): Promise<Snapshot> {
    const snap = await this.video.snapshot();
    this.screen = { width: snap.width, height: snap.height };
    return snap;
  }

  /** Waits for the target UI to react, then captures it. */
  async screenshotAfterSettle(): Promise<Snapshot> {
    await sleep(this.config.settleMs);
    return this.screenshot();
  }

  async close(): Promise<void> {
    this.video.stop();
    await this.link.close();
  }

  // ---- mouse ---------------------------------------------------------------

  async move(x: number, y: number): Promise<void> {
    await this.link.exclusive(() => this.sendAbs(0, this.toAbs(x, y)));
  }

  async click(opts: { x?: number; y?: number; button?: ButtonName; count?: number; modifiers?: string }): Promise<void> {
    const button = BUTTONS[opts.button ?? "left"];
    const count = opts.count ?? 1;
    const modifiers = opts.modifiers ? parseChord(opts.modifiers) : undefined;
    if (modifiers && modifiers.keys.length > 0) throw new Error(`"${opts.modifiers}" must only contain modifier keys`);

    await this.link.exclusive(async () => {
      const pos = this.positionFor(opts.x, opts.y);
      await this.sendAbs(0, pos);
      await sleep(HOVER_MS);
      try {
        if (modifiers) {
          await this.link.send(MsgType.Keyboard, keyboardReport(modifiers.modifiers));
          await sleep(this.config.keyDelayMs);
        }
        for (let i = 0; i < count; i++) {
          if (i > 0) await sleep(MULTI_CLICK_GAP_MS);
          await this.sendAbs(button, pos);
          await sleep(CLICK_HOLD_MS);
          await this.sendAbs(0, pos);
        }
      } finally {
        await this.sendAbs(0, pos);
        if (modifiers) await this.link.send(MsgType.Keyboard, keyboardReport(0));
      }
    });
  }

  async drag(opts: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    button?: ButtonName;
    durationMs?: number;
  }): Promise<void> {
    const button = BUTTONS[opts.button ?? "left"];
    const duration = opts.durationMs ?? 400;
    const steps = Math.max(2, Math.round(duration / 16));
    const from = this.toAbs(opts.fromX, opts.fromY);
    const to = this.toAbs(opts.toX, opts.toY);

    await this.link.exclusive(async () => {
      await this.sendAbs(0, from);
      await sleep(HOVER_MS);
      await this.sendAbs(button, from);
      await sleep(CLICK_HOLD_MS);
      try {
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          await this.sendAbs(button, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
          await sleep(duration / steps);
        }
        await sleep(CLICK_HOLD_MS);
      } finally {
        await this.sendAbs(0, to);
      }
    });
  }

  /**
   * Scrolls by `amount` wheel notches so that `direction` is where the view moves
   * ("down" reveals content further down). Uses HID conventions: wheel +1 scrolls up,
   * AC Pan +1 scrolls right. Targets with natural scrolling (the macOS default) flip
   * both axes; set KIWI_INVERT_SCROLL=1 for those.
   */
  async scroll(opts: { x?: number; y?: number; direction: ScrollDirection; amount?: number }): Promise<void> {
    const amount = Math.max(1, Math.min(50, Math.round(opts.amount ?? 3)));
    const [pan, wheel] = SCROLL_VECTORS[opts.direction];
    const flip = this.config.invertScroll ? -1 : 1;

    await this.link.exclusive(async () => {
      const pos = this.positionFor(opts.x, opts.y);
      await this.sendAbs(0, pos);
      await sleep(HOVER_MS);
      for (let i = 0; i < amount; i++) {
        await this.link.send(
          MsgType.AbsoluteMouse,
          absoluteMouseReport(0, pos.x, pos.y, wheel * flip, pan * flip),
        );
        await sleep(SCROLL_STEP_MS);
      }
    });
  }

  // ---- keyboard ------------------------------------------------------------

  /** Presses a chord like "cmd+space" or "enter", optionally repeated or held. */
  async pressKeys(chord: string, opts: { repeat?: number; holdMs?: number } = {}): Promise<void> {
    const { modifiers, keys } = parseChord(chord);
    const repeat = Math.max(1, Math.min(100, opts.repeat ?? 1));
    const hold = Math.max(this.config.keyDelayMs, opts.holdMs ?? 30);
    const delay = this.config.keyDelayMs;

    await this.link.exclusive(async () => {
      try {
        for (let i = 0; i < repeat; i++) {
          if (modifiers) {
            await this.link.send(MsgType.Keyboard, keyboardReport(modifiers));
            await sleep(delay);
          }
          await this.link.send(MsgType.Keyboard, keyboardReport(modifiers, keys));
          await sleep(hold);
          if (modifiers && keys.length) {
            await this.link.send(MsgType.Keyboard, keyboardReport(modifiers));
            await sleep(delay);
          }
          await this.link.send(MsgType.Keyboard, keyboardReport(0));
          await sleep(delay);
        }
      } finally {
        await this.link.send(MsgType.Keyboard, keyboardReport(0));
      }
    });
  }

  /** Types text as US-layout keystrokes. Rejects text containing characters with no key mapping. */
  async typeText(text: string): Promise<number> {
    if (text.length > MAX_TEXT_LENGTH) throw new Error(`Text is longer than ${MAX_TEXT_LENGTH} characters; split it up`);
    const { strokes, unsupported } = textToKeystrokes(text);
    if (unsupported.length) {
      const shown = unsupported.map((c) => JSON.stringify(c)).join(", ");
      throw new Error(
        `Cannot type ${shown}: only US-keyboard ASCII is supported. Nothing was typed. Remove or replace those characters.`,
      );
    }
    const delay = this.config.keyDelayMs;

    await this.link.exclusive(async () => {
      try {
        let previousKey = -1;
        for (const stroke of strokes) {
          // Same key twice in a row needs a visible release in between, which we always send anyway.
          if (stroke.modifiers) {
            await this.link.send(MsgType.Keyboard, keyboardReport(stroke.modifiers));
            await sleep(delay);
          }
          await this.link.send(MsgType.Keyboard, keyboardReport(stroke.modifiers, [stroke.key]));
          await sleep(delay);
          await this.link.send(MsgType.Keyboard, keyboardReport(0));
          await sleep(stroke.key === previousKey ? delay * 2 : delay);
          previousKey = stroke.key;
        }
      } finally {
        await this.link.send(MsgType.Keyboard, keyboardReport(0));
      }
    });
    return strokes.length;
  }

  /**
   * Switches the Kiwi between normal HID (report protocol, full mouse with wheel)
   * and legacy boot-protocol HID, which BIOS/UEFI setup screens need. The Kiwi also
   * follows the target's own SET_PROTOCOL requests, so this is rarely needed.
   */
  async setHidMode(mode: "normal" | "legacy"): Promise<void> {
    await this.link.exclusive(() => this.link.send(MsgType.HidBootMode, Buffer.from([mode === "legacy" ? 1 : 0])));
  }

  // ---- raw input (live viewer) -----------------------------------------------

  /**
   * Places the pointer at a fraction of the screen (0..1 on each axis) with exactly
   * `buttons` (MouseButton bits) held. The viewer streams these as a person moves,
   * presses, and drags, so no hover or hold delays are added.
   */
  async pointer(fx: number, fy: number, buttons: number): Promise<void> {
    const pos = fractionToAbs(fx, fy, this.video.activeArea);
    await this.link.exclusive(() => this.sendAbs(buttons & 0x1f, pos));
  }

  /** Scrolls at a screen fraction: positive `down` reveals content further down, positive `right` further right. */
  async wheel(fx: number, fy: number, down: number, right: number, buttons = 0): Promise<void> {
    const flip = this.config.invertScroll ? -1 : 1;
    const pos = fractionToAbs(fx, fy, this.video.activeArea);
    await this.link.exclusive(async () => {
      await this.link.send(
        MsgType.AbsoluteMouse,
        absoluteMouseReport(buttons & 0x1f, pos.x, pos.y, -down * flip, right * flip),
      );
      this.abs = pos;
    });
  }

  /** Sends one keyboard report holding exactly these modifiers and keys (the viewer tracks key state). */
  async keyboardState(chord: KeyChord): Promise<void> {
    await this.link.exclusive(() => this.link.send(MsgType.Keyboard, keyboardReport(chord.modifiers, chord.keys)));
  }

  /** Releases every key and mouse button. */
  async releaseAll(): Promise<void> {
    await this.link.exclusive(async () => {
      await this.link.send(MsgType.Keyboard, keyboardReport(0));
      await sleep(this.config.keyDelayMs);
      if (this.abs) await this.sendAbs(0, this.abs);
    });
  }

  // ---- helpers ---------------------------------------------------------------

  /** Maps a pixel in screenshot space (its centre) to the Kiwi's 0..32767 absolute range. */
  toAbs(x: number, y: number): { x: number; y: number } {
    const { width, height } = this.screen;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Coordinates must be numbers");
    if (x < 0 || y < 0 || x >= width || y >= height) {
      throw new Error(`(${x}, ${y}) is outside the ${width}x${height} screenshot area`);
    }
    return fractionToAbs((x + 0.5) / width, (y + 0.5) / height, this.video.activeArea);
  }

  private positionFor(x: number | undefined, y: number | undefined): { x: number; y: number } {
    if (x !== undefined && y !== undefined) return this.toAbs(x, y);
    if (x !== undefined || y !== undefined) throw new Error("Pass both x and y, or neither");
    if (this.abs) return this.abs;
    throw new Error("No known cursor position yet; pass x and y");
  }

  private async sendAbs(buttons: number, pos: { x: number; y: number }): Promise<void> {
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    await this.link.send(MsgType.AbsoluteMouse, absoluteMouseReport(buttons, x, y));
    this.abs = { x, y };
  }
}
