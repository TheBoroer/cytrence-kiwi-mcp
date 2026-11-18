/**
 * Cytrence Kiwi serial protocol ("CyMsg" framing), reverse-engineered from the
 * official macOS app (Cytrence Kiwi.app v1.6.4). See docs/PROTOCOL.md.
 *
 * Frame layout (all integers little-endian):
 *
 *   preamble  3c 5a a5 c3
 *   header    u8 flags, u8 crc8(body), u16 seq, u16 type, u16 bodyLength
 *   body      bodyLength bytes
 *   trailer   c9 6d d6 9c
 */

export const PREAMBLE = Buffer.from([0x3c, 0x5a, 0xa5, 0xc3]);
export const TRAILER = Buffer.from([0xc9, 0x6d, 0xd6, 0x9c]);
export const HEADER_SIZE = 8;
export const FRAME_OVERHEAD = PREAMBLE.length + HEADER_SIZE + TRAILER.length;
/** Upper bound used to resynchronise on garbage; real bodies are tiny. */
export const MAX_BODY_LENGTH = 4096;

export const MsgType = {
  Hello: 0x32,
  KiwiInfo: 0x64,
  /** Persistent 20-byte device config, written to flash. Not used by this server. */
  KiwiConfig: 0x78,
  /** Target USB function toggles: body [deviceType, enable]. Not used by this server. */
  TargetConfig: 0x96,
  InfoRequest: 0xc8,
  Log: 0x12c,
  Keyboard: 0x190,
  RelativeMouse: 0x19a,
  AbsoluteMouse: 0x19b,
  /** body [1] = legacy/boot-protocol HID (BIOS-friendly), [0] = normal report protocol. */
  HidBootMode: 0x1ae,
} as const;

/** Absolute mouse coordinates span 0..ABS_MAX on both axes, regardless of the target resolution. */
export const ABS_MAX = 0x7fff;

export const MouseButton = {
  Left: 0x01,
  Right: 0x02,
  Middle: 0x04,
  Back: 0x08,
  Forward: 0x10,
} as const;

export interface Frame {
  flags: number;
  crc: number;
  seq: number;
  type: number;
  body: Buffer;
  crcOk: boolean;
}

/** CRC-8, polynomial 0x07, init 0x00, no reflection, no final xor. Computed over the body only. */
export function crc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function encodeFrame(type: number, body: Uint8Array, seq: number, flags = 0): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(flags & 0xff, 0);
  header.writeUInt8(crc8(body), 1);
  header.writeUInt16LE(seq & 0xffff, 2);
  header.writeUInt16LE(type & 0xffff, 4);
  header.writeUInt16LE(body.length, 6);
  return Buffer.concat([PREAMBLE, header, Buffer.from(body), TRAILER]);
}

/**
 * Incremental frame decoder. Feed it raw serial chunks; it returns every complete
 * frame and keeps partial data for the next call. Garbage between frames is skipped.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];

    for (;;) {
      const start = this.buf.indexOf(PREAMBLE);
      if (start === -1) {
        // Keep a possible partial preamble at the end.
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - (PREAMBLE.length - 1)));
        return frames;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < PREAMBLE.length + HEADER_SIZE) return frames;

      const flags = this.buf.readUInt8(4);
      const crc = this.buf.readUInt8(5);
      const seq = this.buf.readUInt16LE(6);
      const type = this.buf.readUInt16LE(8);
      const length = this.buf.readUInt16LE(10);

      if (length > MAX_BODY_LENGTH) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      const total = FRAME_OVERHEAD + length;
      if (this.buf.length < total) return frames;

      const trailerAt = PREAMBLE.length + HEADER_SIZE + length;
      if (!this.buf.subarray(trailerAt, trailerAt + TRAILER.length).equals(TRAILER)) {
        this.buf = this.buf.subarray(1);
        continue;
      }

      const body = Buffer.from(this.buf.subarray(PREAMBLE.length + HEADER_SIZE, trailerAt));
      frames.push({ flags, crc, seq, type, body, crcOk: crc8(body) === crc });
      this.buf = this.buf.subarray(total);
    }
  }
}

const clampInt = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));

/** 8-byte USB HID boot keyboard report: modifiers, reserved, up to 6 usage codes. */
export function keyboardReport(modifiers: number, keys: readonly number[] = []): Buffer {
  if (keys.length > 6) throw new Error(`At most 6 simultaneous keys are supported, got ${keys.length}`);
  const report = Buffer.alloc(8);
  report.writeUInt8(modifiers & 0xff, 0);
  keys.forEach((key, i) => report.writeUInt8(key & 0xff, 2 + i));
  return report;
}

/** Absolute mouse report: u8 buttons, u16 x, u16 y (0..32767), i8 wheel, i8 pan. */
export function absoluteMouseReport(buttons: number, x: number, y: number, wheel = 0, pan = 0): Buffer {
  const report = Buffer.alloc(7);
  report.writeUInt8(buttons & 0xff, 0);
  report.writeUInt16LE(clampInt(x, 0, ABS_MAX), 1);
  report.writeUInt16LE(clampInt(y, 0, ABS_MAX), 3);
  report.writeInt8(clampInt(wheel, -127, 127), 5);
  report.writeInt8(clampInt(pan, -127, 127), 6);
  return report;
}

/** Relative mouse report: u8 buttons, i8 dx, i8 dy, i8 wheel, i8 pan. */
export function relativeMouseReport(buttons: number, dx: number, dy: number, wheel = 0, pan = 0): Buffer {
  const report = Buffer.alloc(5);
  report.writeUInt8(buttons & 0xff, 0);
  report.writeInt8(clampInt(dx, -127, 127), 1);
  report.writeInt8(clampInt(dy, -127, 127), 2);
  report.writeInt8(clampInt(wheel, -127, 127), 3);
  report.writeInt8(clampInt(pan, -127, 127), 4);
  return report;
}

/** Body of the 0xC8 info request, as sent by the official app. */
export const INFO_REQUEST_BODY = Buffer.from([0x01, 0x00]);

export interface KiwiInfo {
  model: string;
  /** Application firmware, e.g. "2.10". */
  firmwareVersion?: string;
  firmwareBuild?: string;
  /** Bootloader, e.g. "2.8". */
  bootVersion?: string;
  bootBuild?: string;
  /** Every build timestamp found in the body (fallback if the layout changes). */
  firmwareBuilds: string[];
  raw: string;
}

/**
 * KiwiInfo body layout (132 bytes, firmware 2.10), as far as it is known:
 *   0x0C  model string, NUL-terminated ("Kiwi (v1.1/B)")
 *   0x4C  u16 boot major, u16 boot minor, then build timestamp string at 0x50
 *   0x65  u16 firmware major, u16 firmware minor, then build timestamp string at 0x69
 */
const INFO_MODEL_OFFSET = 0x0c;
const INFO_BOOT_VERSION_OFFSET = 0x4c;
const INFO_FIRMWARE_VERSION_OFFSET = 0x65;

/** Pulls the readable fields out of a 0x64 KiwiInfo body (model string + firmware build timestamps). */
export function parseKiwiInfo(body: Buffer): KiwiInfo {
  const strings = printableRuns(body, 4);
  const timestamps = strings.filter((s) => /^\d{4}\.\d{2}\.\d{2}T/.test(s));
  const atOffset = body.length > INFO_MODEL_OFFSET ? cString(body.subarray(INFO_MODEL_OFFSET)) : "";
  const model =
    (/^[\x20-\x7e]{3,}$/.test(atOffset) ? atOffset : undefined) ??
    strings.find((s) => !timestamps.includes(s) && /kiwi/i.test(s)) ??
    "unknown";
  const boot = versionAt(body, INFO_BOOT_VERSION_OFFSET);
  const firmware = versionAt(body, INFO_FIRMWARE_VERSION_OFFSET);
  return {
    model,
    firmwareVersion: firmware?.version,
    firmwareBuild: firmware?.build,
    bootVersion: boot?.version,
    bootBuild: boot?.build,
    firmwareBuilds: timestamps,
    raw: body.toString("hex"),
  };
}

/** Reads `u16 major, u16 minor, char build[]` and only trusts it if the build looks like a timestamp. */
function versionAt(body: Buffer, offset: number): { version: string; build: string } | undefined {
  if (body.length < offset + 8) return undefined;
  const build = cString(body.subarray(offset + 4));
  if (!/^\d{4}\.\d{2}\.\d{2}T[\d:]+Z?$/.test(build)) return undefined;
  return { version: `${body.readUInt16LE(offset)}.${body.readUInt16LE(offset + 2)}`, build };
}

/** Device log frames (0x12C): u16 level followed by a NUL-terminated string. */
export function parseLogMessage(body: Buffer): { level: number; text: string } {
  const level = body.length >= 2 ? body.readUInt16LE(0) : 0;
  const text = body.subarray(2).toString("latin1").replace(/\0.*$/s, "");
  return { level, text };
}

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("latin1");
}

function printableRuns(buf: Buffer, minLength: number): string[] {
  const runs: string[] = [];
  let current = "";
  for (const byte of buf) {
    if (byte >= 0x20 && byte < 0x7f) {
      current += String.fromCharCode(byte);
    } else {
      if (current.trim().length >= minLength) runs.push(current.trim());
      current = "";
    }
  }
  if (current.trim().length >= minLength) runs.push(current.trim());
  return runs;
}
