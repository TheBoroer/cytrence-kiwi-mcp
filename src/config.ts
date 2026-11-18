export interface KiwiConfig {
  serialPort?: string;
  baudRate: number;
  serialIdleMs: number;
  videoDevice?: string;
  captureSize: string;
  screenshotWidth: number;
  videoIdleMs: number;
  /** Frames per second ffmpeg streams. `undefined` means the default: 10, or 20 under `serve`. */
  streamFps?: number;
  ffmpegPath: string;
  invertScroll: boolean;
  keyDelayMs: number;
  settleMs: number;
  /** After you take over in the viewer, hand control back to the agent once you've been idle this long. 0 disables. */
  autoResumeMs: number;
  /** Find black bars around the target's picture and map the mouse inside them. */
  detectBars: boolean;
  /** A stdio session takes the Kiwi without asking once its owner has been idle this long with no viewer open. */
  handoverIdleMs: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function loadConfig(): KiwiConfig {
  return {
    serialPort: process.env.KIWI_SERIAL_PORT || undefined,
    baudRate: intEnv("KIWI_BAUD", 2_000_000),
    serialIdleMs: intEnv("KIWI_SERIAL_IDLE_MS", 30_000),
    videoDevice: process.env.KIWI_VIDEO_DEVICE || undefined,
    captureSize: process.env.KIWI_CAPTURE_SIZE || "1920x1080",
    screenshotWidth: intEnv("KIWI_SCREENSHOT_WIDTH", 1280),
    videoIdleMs: intEnv("KIWI_VIDEO_IDLE_MS", 60_000),
    streamFps: process.env.KIWI_VIDEO_FPS ? Math.max(1, Math.min(60, intEnv("KIWI_VIDEO_FPS", 10))) : undefined,
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    invertScroll: boolEnv("KIWI_INVERT_SCROLL", false),
    keyDelayMs: intEnv("KIWI_KEY_DELAY_MS", 12),
    settleMs: intEnv("KIWI_SETTLE_MS", 500),
    autoResumeMs: intEnv("KIWI_AUTO_RESUME_MS", 15_000),
    detectBars: boolEnv("KIWI_DETECT_BARS", true),
    handoverIdleMs: intEnv("KIWI_HANDOVER_IDLE_MS", 600_000),
  };
}
