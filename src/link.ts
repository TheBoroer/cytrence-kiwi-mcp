import { SerialPort } from "serialport";
import {
  type Frame,
  FrameDecoder,
  INFO_REQUEST_BODY,
  type KiwiInfo,
  MsgType,
  encodeFrame,
  parseKiwiInfo,
  parseLogMessage,
} from "./protocol.js";

/** The Kiwi exposes a WCH CH340 USB-serial bridge on its internal hub. */
export const KIWI_SERIAL_VID = "1a86";
export const KIWI_SERIAL_PID = "7523";

export interface LinkOptions {
  /** Serial device path. Auto-detected (CH340, VID 1a86 PID 7523) when omitted. */
  path?: string;
  /** The official app uses 2,000,000 baud with RTS/CTS flow control. */
  baudRate?: number;
  /**
   * Close the port after this long without activity so the official Cytrence app
   * can connect in between (it needs the same exclusive lock). 0 keeps it open.
   */
  idleCloseMs?: number;
  log?: (message: string) => void;
}

export interface DeviceLogEntry {
  at: string;
  level: number;
  text: string;
}

interface Waiter {
  type: number;
  resolve: (frame: Frame) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function findKiwiSerialPort(): Promise<string> {
  const ports = await SerialPort.list();
  const matches = ports.filter(
    (p) => p.vendorId?.toLowerCase() === KIWI_SERIAL_VID && p.productId?.toLowerCase() === KIWI_SERIAL_PID,
  );
  if (matches.length === 0) {
    const seen = ports.map((p) => p.path).join(", ") || "none";
    throw new Error(
      `No Cytrence Kiwi serial port found (looking for a CH340, USB ${KIWI_SERIAL_VID}:${KIWI_SERIAL_PID}). ` +
        `Is the Kiwi's host USB-C cable plugged into this computer? Serial ports seen: ${seen}. ` +
        `Set KIWI_SERIAL_PORT to override.`,
    );
  }
  // macOS lists /dev/tty.*; the callout device /dev/cu.* does not wait for carrier detect.
  return matches[0]!.path.replace(/^\/dev\/tty\./, "/dev/cu.");
}

/**
 * Owns the serial connection to the Kiwi. Opens lazily, reconnects after unplug,
 * and serialises all writes so multi-report gestures are never interleaved.
 */
export class KiwiLink {
  private port: SerialPort | undefined;
  private opening: Promise<SerialPort> | undefined;
  private decoder = new FrameDecoder();
  private seq = 0;
  private waiters: Waiter[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly logs: DeviceLogEntry[] = [];
  private lastInfo: KiwiInfo | undefined;
  private lastPath: string | undefined;
  private active = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly log: (message: string) => void;
  /** Why the port must stay closed, while suspended. */
  private suspended: string | undefined;

  constructor(private readonly options: LinkOptions = {}) {
    this.log = options.log ?? ((m) => console.error(`[kiwi] ${m}`));
  }

  get isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  /** Path of the open port, or of the last one used if the link is idle-closed. */
  get path(): string | undefined {
    return this.port?.path ?? this.lastPath;
  }

  get info(): KiwiInfo | undefined {
    return this.lastInfo;
  }

  recentLogs(limit = 20): DeviceLogEntry[] {
    return this.logs.slice(-limit);
  }

  /** Runs `fn` with exclusive access to the device. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const tracked = async () => {
      this.active++;
      clearTimeout(this.idleTimer);
      try {
        return await fn();
      } finally {
        this.active--;
        this.scheduleIdleClose();
      }
    };
    const run = this.queue.then(tracked, tracked);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private scheduleIdleClose(): void {
    const idleMs = this.options.idleCloseMs ?? 0;
    if (idleMs <= 0 || this.active > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.active > 0 || !this.port?.isOpen) return;
      this.log(`closing serial port after ${idleMs} ms idle`);
      void this.close();
    }, idleMs);
    this.idleTimer.unref();
  }

  /**
   * Closes the port and keeps it closed until `resume()`, e.g. while another agent session
   * has the Kiwi. Anything still trying to use it fails with `reason` instead of reopening it.
   */
  async suspend(reason: string): Promise<void> {
    this.suspended = reason;
    await this.opening?.catch(() => undefined);
    await this.close();
  }

  resume(): void {
    this.suspended = undefined;
  }

  async open(): Promise<SerialPort> {
    if (this.suspended) throw new Error(this.suspended);
    if (this.port?.isOpen) return this.port;
    this.opening ??= this.doOpen().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async doOpen(): Promise<SerialPort> {
    const path = this.options.path ?? (await findKiwiSerialPort());
    const baudRate = this.options.baudRate ?? 2_000_000;

    const port = new SerialPort({
      path,
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: true,
      hupcl: false,
      lock: true,
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) =>
      port.open((err) => (err ? reject(describeOpenError(err, path)) : resolve())),
    );

    this.decoder = new FrameDecoder();
    port.on("data", (chunk: Buffer) => this.onData(chunk));
    port.on("error", (err) => this.log(`serial error: ${err.message}`));
    port.on("close", () => {
      this.log(`serial port ${path} closed`);
      if (this.port === port) this.port = undefined;
    });
    this.port = port;
    this.lastPath = path;
    this.log(`opened ${path} @ ${baudRate} baud (RTS/CTS)`);

    // The first frame after the port opens is often dropped by the Kiwi, so
    // warm the link up with a harmless info request before any input is sent.
    const info = await this.requestInfoUnlocked(3, 600).catch(() => undefined);
    if (info) this.log(`connected to ${info.model}`);
    else this.log("Kiwi did not answer the info request; continuing anyway");
    return port;
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const port = this.port;
    this.port = undefined;
    if (port?.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()));
  }

  /** Sends one frame. Call inside `exclusive()` when ordering matters. */
  async send(type: number, body: Uint8Array, flags = 0): Promise<void> {
    const port = await this.open();
    this.seq = (this.seq + 1) & 0xffff;
    const frame = encodeFrame(type, body, this.seq, flags);
    await new Promise<void>((resolve, reject) => {
      port.write(frame, (err) => (err ? reject(err) : undefined));
      port.drain((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Asks the Kiwi to identify itself (type 0xC8 -> 0x64 reply). */
  requestInfo(attempts = 3, timeoutMs = 600): Promise<KiwiInfo> {
    return this.exclusive(async () => {
      await this.open();
      return this.requestInfoUnlocked(attempts, timeoutMs);
    });
  }

  private async requestInfoUnlocked(attempts: number, timeoutMs: number): Promise<KiwiInfo> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const reply = this.waitFor(MsgType.KiwiInfo, timeoutMs);
      await this.send(MsgType.InfoRequest, INFO_REQUEST_BODY);
      const frame = await reply;
      if (frame) {
        this.lastInfo = parseKiwiInfo(frame.body);
        return this.lastInfo;
      }
    }
    throw new Error(`Kiwi did not answer the info request after ${attempts} attempts`);
  }

  private waitFor(type: number, timeoutMs: number): Promise<Frame | undefined> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        type,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private onData(chunk: Buffer): void {
    for (const frame of this.decoder.push(chunk)) {
      if (!frame.crcOk) {
        this.log(`dropping frame type 0x${frame.type.toString(16)} with bad CRC`);
        continue;
      }
      if (frame.type === MsgType.Log) {
        const { level, text } = parseLogMessage(frame.body);
        this.logs.push({ at: new Date().toISOString(), level, text });
        if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
      }
      const matched = this.waiters.filter((w) => w.type === frame.type);
      this.waiters = this.waiters.filter((w) => w.type !== frame.type);
      for (const waiter of matched) waiter.resolve(frame);
    }
  }
}

function describeOpenError(err: Error, path: string): Error {
  if (/lock|busy|EBUSY|EAGAIN|Resource temporarily unavailable/i.test(err.message)) {
    return new Error(
      `Serial port ${path} is in use (${err.message}). Quit the Cytrence Kiwi app, it holds an exclusive lock on the port.`,
    );
  }
  return new Error(`Could not open ${path}: ${err.message}`);
}

export { sleep };
