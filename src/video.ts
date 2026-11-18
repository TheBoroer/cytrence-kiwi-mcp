import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VideoOptions {
  ffmpegPath?: string;
  /** Capture device: AVFoundation/DirectShow name or index, or a /dev/video* path on Linux. Auto-detected when omitted. */
  device?: string;
  /** Requested capture mode, e.g. "1920x1080". */
  captureSize?: string;
  captureFps?: number;
  /** Width of the JPEGs handed to the agent. Height follows the capture aspect ratio. */
  outputWidth?: number;
  /** Frames per second kept flowing while the stream is warm. */
  streamFps?: number;
  /** Stop the background ffmpeg after this long without a screenshot. 0 disables streaming (one ffmpeg per shot). */
  idleStopMs?: number;
  jpegQuality?: number;
  /** Look for black bars around the target's picture (see `findActiveArea`). Default true. */
  detectBars?: boolean;
  log?: (message: string) => void;
}

export interface Snapshot {
  jpeg: Buffer;
  width: number;
  height: number;
  capturedAt: number;
}

/** A rectangle as fractions (0..1) of the video frame. */
export interface FrameArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_FRAME: Readonly<FrameArea> = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** How often to re-check the bars while frames are flowing. */
const AREA_CHECK_MS = 5_000;
/** How often to retry while the bars are still unknown. */
const AREA_RETRY_MS = 1_000;
/** A smaller picture area must show up in this many checks in a row before it is believed. */
const SHRINK_CONFIRMATIONS = 3;
/** Areas closer than this (fraction of the frame, about 5 px at 1280) count as the same. */
const AREA_EPSILON = 0.004;
/** Luma above this is picture. Bars are pure black and stay under about 10 after JPEG. */
const BAR_LUMA = 24;

/**
 * Grabs frames from the Kiwi's UVC capture interface through ffmpeg. A background
 * ffmpeg process is started on the first screenshot and kept warm, so later
 * screenshots only wait for the next frame instead of reopening the device.
 */
export class VideoCapture {
  private proc: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private latest: Snapshot | undefined;
  private waiters: Array<{ after: number; resolve: (s: Snapshot) => void; reject: (e: Error) => void }> = [];
  private readonly subscribers = new Set<(snap: Snapshot) => void>();
  private starting: Promise<void> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private stderrTail: string[] = [];
  private resolvedDevice: string | undefined;
  /** The target's picture inside the frame; undefined until the first successful check. */
  private area: FrameArea | undefined;
  private shrinkCandidate: { area: FrameArea; seen: number } | undefined;
  private areaCheck: Promise<void> | undefined;
  private areaCheckedAt = 0;
  private readonly opts: Required<Omit<VideoOptions, "device" | "log">> & Pick<VideoOptions, "device">;
  private readonly log: (message: string) => void;

  constructor(options: VideoOptions = {}) {
    this.opts = {
      ffmpegPath: options.ffmpegPath ?? "ffmpeg",
      device: options.device,
      captureSize: options.captureSize ?? "1920x1080",
      captureFps: options.captureFps ?? 30,
      outputWidth: options.outputWidth ?? 1280,
      streamFps: options.streamFps ?? 10,
      idleStopMs: options.idleStopMs ?? 60_000,
      jpegQuality: options.jpegQuality ?? 4,
      detectBars: options.detectBars ?? true,
    };
    this.log = options.log ?? ((m) => console.error(`[kiwi-video] ${m}`));
  }

  get streaming(): boolean {
    return this.proc !== undefined;
  }

  /**
   * Where the target's picture sits in the frame. When the target's screen isn't 16:9
   * it arrives centred between black bars, and its absolute mouse range covers only
   * the picture, not the bars.
   */
  get activeArea(): Readonly<FrameArea> {
    return this.area ?? FULL_FRAME;
  }

  /** Returns a frame captured after this call started. */
  async snapshot(timeoutMs = 10_000): Promise<Snapshot> {
    const snap = await this.captureFrame(timeoutMs);
    // Coordinates in this frame should map with bars that match it, so let a pending check finish.
    this.maybeCheckArea(snap);
    await this.areaCheck;
    return snap;
  }

  private async captureFrame(timeoutMs: number): Promise<Snapshot> {
    const requestedAt = Date.now();
    // A one-shot ffmpeg would fight a running stream for the device, so only use it when nothing is streaming.
    if (this.opts.idleStopMs <= 0 && !this.proc && this.subscribers.size === 0) return this.oneShot(timeoutMs);

    await this.ensureStream();
    this.touchIdleTimer();
    return new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`No video frame within ${timeoutMs} ms. ${this.ffmpegHint()}`));
      }, timeoutMs);
      const waiter = {
        after: requestedAt,
        resolve: (s: Snapshot) => {
          clearTimeout(timer);
          resolve(s);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * Calls `listener` with every streamed frame (the live viewer uses this). The stream
   * stays up while anyone is subscribed and is restarted if ffmpeg dies. Resolves with
   * an unsubscribe function once ffmpeg has been started.
   */
  async subscribe(listener: (snap: Snapshot) => void): Promise<() => void> {
    this.subscribers.add(listener);
    clearTimeout(this.idleTimer);
    try {
      await this.ensureStream();
    } catch (err) {
      this.unsubscribe(listener);
      throw err;
    }
    if (this.latest && Date.now() - this.latest.capturedAt < 1000) listener(this.latest);
    return () => this.unsubscribe(listener);
  }

  private unsubscribe(listener: (snap: Snapshot) => void): void {
    if (this.subscribers.delete(listener) && this.subscribers.size === 0 && this.proc) this.touchIdleTimer();
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = undefined;
    }
  }

  async describeDevice(): Promise<string> {
    return this.resolveDevice();
  }

  private touchIdleTimer(): void {
    clearTimeout(this.idleTimer);
    if (this.subscribers.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.log("stopping idle video stream");
      this.stop();
    }, this.opts.idleStopMs);
    this.idleTimer.unref();
  }

  /** Starts ffmpeg unless it is already running or starting, so concurrent callers share one process. */
  private ensureStream(): Promise<void> {
    if (this.proc) return Promise.resolve();
    this.starting ??= this.startStream().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startStream(): Promise<void> {
    const args = [
      ...(await this.inputArgs()),
      "-vf",
      `fps=${this.opts.streamFps},scale=${this.opts.outputWidth}:-2`,
      "-c:v",
      "mjpeg",
      "-q:v",
      String(this.opts.jpegQuality),
      "-f",
      "image2pipe",
      "pipe:1",
    ];
    this.log(`starting ffmpeg ${args.join(" ")}`);
    const proc = spawn(this.opts.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.stderrTail = [];

    let pending: Buffer = Buffer.alloc(0);
    proc.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        const start = pending.indexOf(SOI);
        if (start === -1) {
          pending = Buffer.alloc(0);
          break;
        }
        const end = pending.indexOf(EOI, start + 2);
        if (end === -1) {
          pending = pending.subarray(start);
          break;
        }
        this.onFrame(Buffer.from(pending.subarray(start, end + 2)));
        pending = pending.subarray(end + 2);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => this.pushStderr(chunk));
    proc.on("error", (err) => this.failStream(new Error(`Could not start ffmpeg: ${err.message}`), proc));
    proc.on("exit", (code, signal) => {
      if (signal === "SIGTERM" && this.proc !== proc) return;
      this.failStream(new Error(`ffmpeg exited (code ${code}, signal ${signal}). ${this.ffmpegHint()}`), proc);
    });
  }

  private onFrame(jpeg: Buffer): void {
    const size = jpegSize(jpeg);
    if (!size) return;
    const snap: Snapshot = { jpeg, ...size, capturedAt: Date.now() };
    this.latest = snap;
    this.maybeCheckArea(snap);
    const ready = this.waiters.filter((w) => snap.capturedAt > w.after);
    this.waiters = this.waiters.filter((w) => snap.capturedAt <= w.after);
    for (const w of ready) w.resolve(snap);
    for (const listener of this.subscribers) listener(snap);
  }

  // ---- black bars ------------------------------------------------------------

  /** Starts a background bar check on this frame unless one is running or one ran recently. */
  private maybeCheckArea(snap: Snapshot): void {
    if (!this.opts.detectBars || this.areaCheck) return;
    // Until a check succeeds (a dark screen can't be read), retry sooner, but never every frame.
    const interval = this.area ? AREA_CHECK_MS : AREA_RETRY_MS;
    if (snap.capturedAt - this.areaCheckedAt < interval) return;
    this.areaCheckedAt = snap.capturedAt;
    this.areaCheck = this.checkArea(snap).finally(() => {
      this.areaCheck = undefined;
    });
  }

  private async checkArea(snap: Snapshot): Promise<void> {
    try {
      const gray = await this.decodeGray(snap.jpeg, snap.width * snap.height);
      const found = findActiveArea(gray, snap.width, snap.height);
      if (found) this.updateArea(found, snap);
    } catch (err) {
      this.log(`black bar check failed: ${(err as Error).message}`);
    }
  }

  /**
   * Dark content at the picture's edge can pass for bar, never the other way round, so a
   * larger area is believed at once. A smaller one has to repeat (the target switched
   * resolution) before it replaces the current one.
   */
  private updateArea(found: FrameArea, snap: Snapshot): void {
    const current = this.area;
    let accept = !current || (found.width >= current.width - AREA_EPSILON && found.height >= current.height - AREA_EPSILON);
    if (accept) {
      this.shrinkCandidate = undefined;
    } else {
      const candidate = this.shrinkCandidate;
      if (candidate && sameArea(candidate.area, found)) candidate.seen++;
      else this.shrinkCandidate = { area: found, seen: 1 };
      accept = (this.shrinkCandidate?.seen ?? 0) >= SHRINK_CONFIRMATIONS;
      if (accept) this.shrinkCandidate = undefined;
    }
    if (!accept || (current && sameArea(current, found))) return;
    this.area = found;
    const px = (f: number, size: number) => Math.round(f * size);
    this.log(
      found.width >= 1 && found.height >= 1
        ? "no black bars around the picture"
        : `picture is ${px(found.width, snap.width)}x${px(found.height, snap.height)} at (${px(found.x, snap.width)}, ${px(found.y, snap.height)}) inside black bars; mouse mapped to it`,
    );
  }

  /** Decodes a JPEG to 8-bit luma, one byte per pixel. */
  private decodeGray(jpeg: Buffer, pixels: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const args = ["-hide_banner", "-loglevel", "error", "-f", "jpeg_pipe", "-i", "pipe:0"];
      args.push("-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "pipe:1");
      const proc = spawn(this.opts.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"], timeout: 5_000 });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      proc.stdin.on("error", () => undefined); // ffmpeg may exit before reading everything
      proc.on("error", reject);
      proc.on("close", (code) => {
        const gray = Buffer.concat(out);
        if (code === 0 && gray.length === pixels) resolve(gray);
        else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString("utf8").trim().slice(-200)}`));
      });
      proc.stdin.end(jpeg);
    });
  }

  private failStream(err: Error, proc: ChildProcessByStdio<null, Readable, Readable>): void {
    if (this.proc === proc) this.proc = undefined;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
    if (waiters.length === 0) this.log(err.message);
    if (this.subscribers.size > 0 && !this.restartTimer) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.subscribers.size > 0) this.ensureStream().catch((e: Error) => this.log(e.message));
      }, 2000);
      this.restartTimer.unref();
    }
  }

  private async oneShot(timeoutMs: number): Promise<Snapshot> {
    const args = [
      ...(await this.inputArgs()),
      "-frames:v",
      "1",
      "-vf",
      `scale=${this.opts.outputWidth}:-2`,
      "-c:v",
      "mjpeg",
      "-q:v",
      String(this.opts.jpegQuality),
      "-f",
      "image2pipe",
      "pipe:1",
    ];
    try {
      const { stdout } = await execFileAsync(this.opts.ffmpegPath, args, {
        encoding: "buffer",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      const size = jpegSize(stdout);
      if (!size) throw new Error("ffmpeg returned no JPEG data");
      return { jpeg: stdout, ...size, capturedAt: Date.now() };
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim().split("\n").slice(-5).join("\n");
      throw new Error(`Screenshot failed: ${(err as Error).message}${stderr ? `\n${stderr}` : ""}`);
    }
  }

  private async inputArgs(): Promise<string[]> {
    const device = await this.resolveDevice();
    const common = ["-hide_banner", "-loglevel", "error", "-nostdin"];
    const size = ["-video_size", this.opts.captureSize, "-framerate", String(this.opts.captureFps)];
    switch (process.platform) {
      case "darwin":
        return [...common, "-f", "avfoundation", ...size, "-pixel_format", "nv12", "-i", `${device}:none`];
      case "linux":
        return [...common, "-f", "v4l2", ...size, "-i", device];
      case "win32":
        return [...common, "-f", "dshow", ...size, "-i", `video=${device}`];
      default:
        throw new Error(`Video capture is not implemented for ${process.platform}`);
    }
  }

  private async resolveDevice(): Promise<string> {
    if (this.opts.device) return this.opts.device;
    if (this.resolvedDevice) return this.resolvedDevice;
    this.resolvedDevice = await detectKiwiVideoDevice(this.opts.ffmpegPath);
    this.log(`using capture device "${this.resolvedDevice}"`);
    return this.resolvedDevice;
  }

  private pushStderr(chunk: Buffer): void {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      this.stderrTail.push(line.trim());
      if (this.stderrTail.length > 10) this.stderrTail.shift();
    }
  }

  private ffmpegHint(): string {
    const tail = this.stderrTail.slice(-3).join(" | ");
    const permission =
      process.platform === "darwin"
        ? " On macOS the app running this server needs Camera permission (System Settings > Privacy & Security > Camera)."
        : "";
    return `${tail ? `ffmpeg said: ${tail}.` : ""}${permission}`;
  }
}

/** Finds the Kiwi's capture device by name ("Cytrence Kiwi (<serial>)"). */
export async function detectKiwiVideoDevice(ffmpegPath = "ffmpeg"): Promise<string> {
  const pattern = /cytrence|kiwi/i;

  if (process.platform === "linux") {
    const entries = await readdir("/sys/class/video4linux").catch(() => [] as string[]);
    for (const entry of entries.sort()) {
      const name = await readFile(`/sys/class/video4linux/${entry}/name`, "utf8").catch(() => "");
      if (pattern.test(name)) return `/dev/${entry}`;
    }
    throw new Error("No Kiwi capture device found under /sys/class/video4linux. Set KIWI_VIDEO_DEVICE.");
  }

  const listArgs =
    process.platform === "darwin"
      ? ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]
      : ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"];

  // ffmpeg exits non-zero after listing devices; the list is on stderr either way.
  const output = await execFileAsync(ffmpegPath, listArgs, { timeout: 15_000 }).then(
    (r) => r.stderr,
    (err: { stderr?: string; code?: string; message: string }) => {
      if (err.code === "ENOENT") throw new Error(`ffmpeg not found (${ffmpegPath}). Install it, e.g. "brew install ffmpeg".`);
      return err.stderr ?? "";
    },
  );

  if (process.platform === "darwin") {
    const videoSection = output.split(/AVFoundation audio devices/)[0] ?? "";
    for (const line of videoSection.split("\n")) {
      const match = /\[(\d+)\] (.+)$/.exec(line.trim());
      if (match && pattern.test(match[2]!)) return match[2]!.trim();
    }
  } else {
    for (const line of output.split("\n")) {
      const match = /"([^"]+)" \(video\)/.exec(line);
      if (match && pattern.test(match[1]!)) return match[1]!;
    }
  }
  throw new Error(
    "No Kiwi capture device found. Check that the Kiwi's host cable is connected and that the target is sending video. Set KIWI_VIDEO_DEVICE to override.",
  );
}

/** Reads width/height from the first SOFn marker of a JPEG. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | undefined {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return undefined;
    const marker = jpeg[i + 1]!;
    const segmentLength = jpeg.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    i += 2 + segmentLength;
  }
  return undefined;
}

/**
 * Finds the target's picture inside a frame by trimming black bars (letterbox or
 * pillarbox) from each edge. `gray` is 8-bit luma, row-major, `width * height` bytes.
 * Returns undefined when the frame is too dark to tell (screen off, black wallpaper).
 */
export function findActiveArea(gray: Uint8Array, width: number, height: number): FrameArea | undefined {
  // A row or column is picture once a few pixels in it are clearly brighter than a bar.
  const minLitCol = Math.max(2, Math.floor(height * 0.005));
  const minLitRow = Math.max(2, Math.floor(width * 0.005));
  const colLit = new Uint32Array(width);
  const rowLit = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (gray[row + x]! > BAR_LUMA) {
        colLit[x]!++;
        rowLit[y]!++;
      }
    }
  }
  const edges = (lit: Uint32Array, min: number): [number, number] | undefined => {
    let first = 0;
    while (first < lit.length && lit[first]! < min) first++;
    let last = lit.length - 1;
    while (last > first && lit[last]! < min) last--;
    return first < last ? [first, last] : undefined;
  };
  const cols = edges(colLit, minLitCol);
  const rows = edges(rowLit, minLitRow);
  if (!cols || !rows) return undefined;
  // Picture this small is a dark screen with a bright patch, not a resolution change.
  if (cols[1] - cols[0] + 1 < width * 0.25 || rows[1] - rows[0] + 1 < height * 0.25) return undefined;
  // Snap edges that land within half a percent of the frame border, so JPEG fuzz isn't read as a bar.
  const snapX = Math.ceil(width * 0.005);
  const snapY = Math.ceil(height * 0.005);
  const left = cols[0] <= snapX ? 0 : cols[0];
  const right = cols[1] >= width - 1 - snapX ? width - 1 : cols[1];
  const top = rows[0] <= snapY ? 0 : rows[0];
  const bottom = rows[1] >= height - 1 - snapY ? height - 1 : rows[1];
  return {
    x: left / width,
    y: top / height,
    width: (right - left + 1) / width,
    height: (bottom - top + 1) / height,
  };
}

function sameArea(a: FrameArea, b: FrameArea): boolean {
  return (
    Math.abs(a.x - b.x) < AREA_EPSILON &&
    Math.abs(a.y - b.y) < AREA_EPSILON &&
    Math.abs(a.width - b.width) < AREA_EPSILON &&
    Math.abs(a.height - b.height) < AREA_EPSILON
  );
}
