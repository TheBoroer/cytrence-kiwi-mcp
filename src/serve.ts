import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import {
  createMcpHandler,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import { chordFromCodes, textToKeystrokes } from "./keys.js";
import { type Kiwi, MAX_TEXT_LENGTH } from "./kiwi.js";
import { type AgentHooks, VERSION, createKiwiServer } from "./tools.js";
import type { Snapshot } from "./video.js";
import { VIEWER_HTML } from "./viewer.js";

/** Default viewer port, for `serve` and for stdio sessions. Override with --port or KIWI_PORT. */
export const DEFAULT_PORT = 7523;

export const HOST = "127.0.0.1";
const MCP_BODY_LIMIT = 4 * 1024 * 1024;
const INPUT_BODY_LIMIT = 256 * 1024;
const MAX_EVENTS_PER_REQUEST = 500;
const LOG_HISTORY = 100;
const SSE_PING_MS = 25_000;
const MJPEG_BOUNDARY = "kiwiframe";

export interface ServeOptions {
  port?: number;
  /**
   * After you take over in the viewer, the agent gets control back once you've sent no
   * input for this long. 0 keeps it paused until you press Resume. Default 15 s.
   */
  autoResumeMs?: number;
  /** Serve the streamable HTTP MCP endpoint at `/mcp` (default true). Stdio sessions turn it off. */
  mcp?: boolean;
  /** Lets another stdio session take the Kiwi over through `POST /handover`. Off for `serve`. */
  handover?: HandoverOptions;
}

export interface HandoverOptions {
  /** Milliseconds since this session's agent last used the Kiwi. */
  idleMs(): number;
  /** Lets go of the Kiwi (serial port and video). The server closes itself right after. */
  release(): Promise<void>;
}

/** What `GET /owner` answers, so a stdio session can tell who holds the viewer port. */
export interface OwnerInfo {
  app: "cytrence-kiwi";
  version: string;
  mode: "stdio" | "serve";
  pid: number;
  /** Open viewer pages. */
  viewers: number;
  paused: boolean;
  /** Time since the agent last used the Kiwi. `null` under `serve`. */
  idleMs: number | null;
}

export interface RunningServer {
  url: string;
  /** Pause state and action log of the viewer, for an MCP server running outside `/mcp`. */
  hooks: AgentHooks;
  close(): Promise<void>;
}

interface LogEntry {
  at: number;
  who: "agent" | "you" | "system";
  text: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs the long-lived server: a live viewer at `/` (video plus your own mouse and
 * keyboard), and a streamable HTTP MCP endpoint at `/mcp` that agents connect to.
 * Both share one Kiwi, so you and the agent see and drive the same machine.
 */
export async function serve(kiwi: Kiwi, options: ServeOptions = {}): Promise<RunningServer> {
  const port = options.port ?? DEFAULT_PORT;
  const autoResumeMs = options.autoResumeMs ?? 15_000;
  const allowedHosts = localhostAllowedHostnames();
  const allowedOrigins = localhostAllowedOrigins();
  const log = (message: string) => console.error(`[kiwi] ${message}`);

  // ---- shared state ----------------------------------------------------------

  const state = { paused: false, autoPause: true, viewers: 0, videoError: undefined as string | undefined };
  const history: LogEntry[] = [];
  const sseClients = new Set<ServerResponse>();
  /** When a takeover pause ends on its own (epoch ms). Unset while the agent is active or after a manual pause. */
  let resumeAt: number | undefined;
  let resumeTimer: NodeJS.Timeout | undefined;
  /** Pastes still being typed from the viewer. */
  let pasting = 0;
  /** `resumeAt` as last sent to viewers, so pushing it back on every mouse move doesn't flood them. */
  let announcedResumeAt: number | undefined;

  function sse(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function statusPayload() {
    return {
      ...state,
      autoResumeMs,
      resumeInMs: resumeAt === undefined ? null : Math.max(0, resumeAt - Date.now()),
      screen: kiwi.screenSize,
    };
  }

  function broadcastStatus(): void {
    announcedResumeAt = resumeAt;
    const payload = statusPayload();
    for (const client of sseClients) sse(client, "status", payload);
  }

  function addLog(who: LogEntry["who"], text: string): void {
    const entry: LogEntry = { at: Date.now(), who, text };
    history.push(entry);
    if (history.length > LOG_HISTORY) history.shift();
    for (const client of sseClients) sse(client, "log", entry);
  }

  /**
   * `untilIdle` marks a takeover: the agent gets control back by itself once you've sent
   * no input for `autoResumeMs`. A pause from the button lasts until you press Resume.
   */
  function setPaused(paused: boolean, who: LogEntry["who"], reason: string, untilIdle = false): void {
    clearTimeout(resumeTimer);
    resumeTimer = undefined;
    resumeAt = undefined;
    if (paused && untilIdle && autoResumeMs > 0) armAutoResume();
    if (state.paused !== paused) {
      state.paused = paused;
      addLog(who, reason);
    }
    broadcastStatus();
  }

  function armAutoResume(): void {
    clearTimeout(resumeTimer);
    resumeAt = Date.now() + autoResumeMs;
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (pasting) return armAutoResume();
      setPaused(false, "system", `No input from you for ${seconds(autoResumeMs)} s, agent resumed`);
    }, autoResumeMs);
    resumeTimer.unref();
  }

  /** Every input you send during a takeover pushes the auto-resume back. */
  function noteActivity(): void {
    if (resumeAt === undefined) return;
    armAutoResume();
    // Viewers count down on their own, so refreshing them about once a second is enough.
    if (announcedResumeAt === undefined || resumeAt - announcedResumeAt >= 1000) broadcastStatus();
  }

  /** Set once the server is listening and the port is known. */
  let viewerUrl = "";

  const hooks: AgentHooks = {
    viewerInfo: () => (viewerUrl ? { url: viewerUrl, tabs: Math.max(sseClients.size, state.viewers) } : undefined),
    isPaused: () => state.paused,
    pausedHint: () =>
      resumeAt === undefined
        ? "Wait for them to resume you"
        : `Control comes back on its own after ${seconds(autoResumeMs)} s without input from them (about ${seconds(resumeAt - Date.now())} s from now if they have stopped), so wait at least that long`,
    onAction: (summary) => addLog("agent", summary),
  };

  const mcp =
    options.mcp === false
      ? undefined
      : createMcpHandler(() => createKiwiServer(kiwi, hooks), {
          legacy: "stateless",
          onerror: (err) => log(`mcp: ${err.message}`),
        });

  function ownerInfo(): OwnerInfo {
    return {
      app: "cytrence-kiwi",
      version: VERSION,
      mode: options.handover ? "stdio" : "serve",
      pid: process.pid,
      viewers: Math.max(sseClients.size, state.viewers),
      paused: state.paused,
      idleMs: options.handover ? Math.max(0, options.handover.idleMs()) : null,
    };
  }

  // ---- routes ------------------------------------------------------------------

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding guard: only answer requests addressed to localhost.
    const host = validateHostHeader(req.headers.host, allowedHosts);
    if (!host.ok) throw new HttpError(403, host.message);
    const origin = validateOriginHeader(req.headers.origin, allowedOrigins);
    if (!origin.ok) throw new HttpError(403, "Origin not allowed");

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    if (url.pathname === "/mcp") {
      if (!mcp) throw new HttpError(404, "This session serves MCP on stdio, not HTTP");
      return handleMcp(mcp, req, res, url);
    }

    if (url.pathname === "/handover" && method === "POST" && options.handover) {
      // Only another Kiwi session may ask, never a web page: browsers always send an
      // Origin header on POST, and a JSON body from another origin needs CORS we never grant.
      if (req.headers.origin !== undefined) throw new HttpError(403, "Handover is only for other Kiwi sessions");
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        throw new HttpError(415, "Expected a JSON body");
      }
      return handleHandover(options.handover, res);
    }

    if (method === "POST") {
      // The viewer's own page is the only browser origin allowed to drive input.
      const own = `http://${req.headers.host}`;
      if (req.headers.origin !== undefined && req.headers.origin !== own) {
        throw new HttpError(403, "Input is only accepted from the viewer page");
      }
      if (url.pathname === "/input") return handleInput(req, res);
      if (url.pathname === "/control") return handleControl(req, res);
    }

    if (method === "GET" || method === "HEAD") {
      if (url.pathname === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
        });
        res.end(method === "HEAD" ? undefined : VIEWER_HTML);
        return;
      }
      if (url.pathname === "/stream.mjpg") return streamVideo(req, res);
      if (url.pathname === "/events") return streamEvents(res);
      if (url.pathname === "/owner") return sendJson(res, 200, ownerInfo());
    }

    throw new HttpError(404, "Not found");
  }

  /** Multipart JPEG stream, which an <img> renders as live video with no client code. */
  async function streamVideo(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    let closed = false;
    let draining = false;
    let unsubscribe: (() => void) | undefined;
    state.viewers++;
    res.on("close", () => {
      closed = true;
      unsubscribe?.();
      state.viewers--;
      broadcastStatus();
    });

    const onFrame = (snap: Snapshot) => {
      if (closed || draining) return; // Slow client: drop frames rather than buffer them.
      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
          "Cache-Control": "no-store",
          Connection: "close",
        });
      }
      res.write(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${snap.jpeg.length}\r\n\r\n`);
      res.write(snap.jpeg);
      if (!res.write("\r\n")) {
        draining = true;
        res.once("drain", () => {
          draining = false;
        });
      }
    };

    try {
      unsubscribe = await kiwi.video.subscribe(onFrame);
    } catch (err) {
      state.videoError = (err as Error).message;
      broadcastStatus();
      throw new HttpError(503, state.videoError);
    }
    if (closed) {
      unsubscribe();
      return;
    }
    state.videoError = undefined;
    broadcastStatus();
  }

  function streamEvents(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    sse(res, "status", statusPayload());
    for (const entry of history) sse(res, "log", entry);
    sseClients.add(res);
    res.on("close", () => sseClients.delete(res));
  }

  async function handleInput(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parseJson(await readBody(req, INPUT_BODY_LIMIT));
    const events = (body as { events?: unknown }).events;
    if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_REQUEST) {
      throw new HttpError(400, "Expected { events: [...] }");
    }

    for (const raw of events) {
      const ev = (raw ?? {}) as Record<string, unknown>;
      // Reject a bad paste before it counts as a takeover.
      if (ev.t === "paste") checkPasteText(ev.text);
      if (state.autoPause && !state.paused && isTakeover(ev)) {
        setPaused(true, "you", "You took over, agent input paused", true);
      } else if (ev.t !== "release") {
        noteActivity();
      }
      try {
        await applyInput(ev);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, (err as Error).message);
      }
    }
    sendJson(res, 200, { ok: true });
  }

  /** A long paste can take minutes to type; the idle countdown starts once it is done. */
  async function paste(text: string): Promise<void> {
    pasting++;
    try {
      const count = await kiwi.typeText(text);
      addLog("you", `Pasted ${count} characters`);
    } finally {
      pasting--;
      noteActivity();
    }
  }

  async function applyInput(ev: Record<string, unknown>): Promise<void> {
    switch (ev.t) {
      case "pointer":
        return kiwi.pointer(num(ev.x), num(ev.y), int(ev.b));
      case "wheel":
        return kiwi.wheel(num(ev.x), num(ev.y), int(ev.dy), int(ev.dx), int(ev.b));
      case "keys": {
        const codes = ev.codes;
        if (!Array.isArray(codes) || codes.length > 32 || !codes.every((c) => typeof c === "string")) {
          throw new HttpError(400, "keys needs a list of KeyboardEvent.code strings");
        }
        return kiwi.keyboardState(chordFromCodes(codes));
      }
      case "combo": {
        const combo = str(ev.combo);
        await kiwi.pressKeys(combo);
        addLog("you", `Pressed ${combo}`);
        return;
      }
      case "release":
        return kiwi.releaseAll();
      case "paste":
        return paste(checkPasteText(ev.text));
      default:
        throw new HttpError(400, `Unknown input event type ${JSON.stringify(ev.t)}`);
    }
  }

  async function handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parseJson(await readBody(req, INPUT_BODY_LIMIT)) as { paused?: unknown; autoPause?: unknown };
    if (typeof body.autoPause === "boolean" && body.autoPause !== state.autoPause) {
      state.autoPause = body.autoPause;
      broadcastStatus();
    }
    if (typeof body.paused === "boolean") {
      setPaused(body.paused, "you", body.paused ? "You paused the agent" : "You resumed the agent");
    }
    sendJson(res, 200, statusPayload());
  }

  /**
   * Another stdio session is taking the Kiwi. Let go of the device first, answer, then
   * close so the viewer port (which doubles as the lock) frees up for the new owner.
   * Open viewer pages reconnect to the new owner on their own.
   */
  async function handleHandover(handover: HandoverOptions, res: ServerResponse): Promise<void> {
    addLog("system", "Another agent session took over the Kiwi");
    await handover.release();
    res.once("finish", () => void close());
    sendJson(res, 200, { ok: true });
  }

  /** Bridges Node's request/response to the SDK's fetch-style handler. */
  async function handleMcp(
    handler: McpHandler,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, MCP_BODY_LIMIT);
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    const response = await handler.fetch(new Request(url, { method, headers, body, signal: abort.signal }));
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      outHeaders[name] = value;
    });
    res.writeHead(response.status, outHeaders);
    if (!response.body) {
      res.end();
      return;
    }
    res.flushHeaders();
    const reader = response.body.getReader();
    res.on("close", () => void reader.cancel().catch(() => undefined));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || res.destroyed) break;
        res.write(value);
      }
    } finally {
      res.end();
    }
  }

  // ---- server ------------------------------------------------------------------

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) log(`${req.method} ${req.url}: ${message}`);
      if (res.headersSent) res.destroy();
      else sendJson(res, status, { error: message });
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    await mcp?.close().catch(() => undefined);
    throw err;
  }

  const ping = setInterval(() => {
    for (const client of sseClients) client.write(": ping\n\n");
  }, SSE_PING_MS);
  ping.unref();

  addLog("system", options.handover ? "Agent session started" : "Server started");

  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : port;
  viewerUrl = `http://${HOST}:${boundPort}/`;

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      clearInterval(ping);
      clearTimeout(resumeTimer);
      for (const client of sseClients) client.end();
      await mcp?.close().catch(() => undefined);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    })();
    return closing;
  }

  return { url: `http://${HOST}:${boundPort}`, hooks, close };
}

type McpHandler = ReturnType<typeof createMcpHandler>;

/** Headers that describe this hop's connection, not the request, so they are not forwarded. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade"]);

/** Events that mean a person is actively using the machine (moving the mouse alone does not count). */
function isTakeover(ev: Record<string, unknown>): boolean {
  switch (ev.t) {
    case "pointer":
      return typeof ev.b === "number" && ev.b !== 0;
    case "keys":
      return Array.isArray(ev.codes) && ev.codes.length > 0;
    case "wheel":
    case "combo":
    case "paste":
      return true;
    default:
      return false;
  }
}

/** Text from the viewer's Paste button, checked so nothing is typed unless all of it can be. */
function checkPasteText(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new HttpError(400, "Nothing to paste");
  if (value.length > MAX_TEXT_LENGTH) {
    throw new HttpError(400, `Clipboard has ${value.length} characters; the limit is ${MAX_TEXT_LENGTH}`);
  }
  const { unsupported } = textToKeystrokes(value);
  if (unsupported.length) {
    const shown = unsupported.slice(0, 5).map((c) => JSON.stringify(c)).join(", ");
    throw new HttpError(400, `Can't type ${shown}: only US-keyboard characters work. Nothing was pasted.`);
  }
  return value;
}

/** Whole seconds, rounded up so a countdown never shows 0 while time is left. */
function seconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "Expected a number");
  return value;
}

function int(value: unknown): number {
  return value === undefined ? 0 : Math.round(num(value));
}

function str(value: unknown): string {
  if (typeof value !== "string" || !value) throw new HttpError(400, "Expected a non-empty string");
  return value;
}

function parseJson(text: string): object {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object") return value;
  } catch {
    // Fall through to the error below.
  }
  throw new HttpError(400, "Body must be a JSON object");
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(text);
}
