import { request } from "node:http";
import type { Kiwi } from "./kiwi.js";
import { HOST, type OwnerInfo, type RunningServer, serve } from "./serve.js";
import type { AgentHooks, Claim, ViewerInfo } from "./tools.js";

export interface SessionOptions {
  /** Viewer port. Whichever session is listening on it owns the Kiwi. */
  port: number;
  autoResumeMs?: number;
  /** Take the Kiwi without asking once its owner has been idle this long with no viewer open. */
  handoverIdleMs: number;
  log?: (message: string) => void;
}

/** How long a new owner waits for the old one to free the viewer port. */
const HANDOVER_WAIT_MS = 5_000;

/**
 * One stdio session's claim on the Kiwi. Every MCP client session starts its own stdio
 * server, but the Kiwi's serial port only takes one program, so the sessions share it
 * through the viewer port: the session listening on it owns the Kiwi and runs the live
 * viewer there. A session claims it on its first tool call (sessions that never touch
 * the Kiwi hold nothing). If another session has it, the tools say so and the agent asks
 * the user before calling `take_over`, unless that session has gone idle.
 */
export class StdioSession implements AgentHooks {
  private viewer: RunningServer | undefined;
  /** When another session took the Kiwi from us (epoch ms). */
  private releasedAt: number | undefined;
  private lastUsed = Date.now();
  private pending: Promise<Claim> | undefined;
  private closed = false;
  private readonly log: (message: string) => void;

  constructor(
    private readonly kiwi: Kiwi,
    private readonly options: SessionOptions,
  ) {
    this.log = options.log ?? ((m) => console.error(`[kiwi] ${m}`));
  }

  private get base(): string {
    return `http://${HOST}:${this.options.port}`;
  }

  claim(): Promise<Claim> {
    this.lastUsed = Date.now();
    if (this.viewer) return Promise.resolve({});
    if (this.releasedAt !== undefined) {
      return Promise.resolve({
        blocked: `Another agent session took over the Kiwi ${ago(this.releasedAt)}. Ask the user before taking it back with take_over.`,
      });
    }
    return this.run(false);
  }

  async takeOver(): Promise<string> {
    this.lastUsed = Date.now();
    while (this.pending) await this.pending;
    if (this.viewer) return `This session already has the Kiwi. Live viewer: ${this.viewer.url}/`;
    const claim = await this.run(true);
    if (claim.blocked) throw new Error(claim.blocked);
    return `This session has the Kiwi now. ${claim.note ?? ""}`.trim();
  }

  viewerInfo(): ViewerInfo | undefined {
    return this.viewer?.hooks.viewerInfo?.();
  }

  isPaused(): boolean {
    return this.viewer?.hooks.isPaused() ?? false;
  }

  pausedHint(): string {
    return this.viewer?.hooks.pausedHint?.() ?? "Wait for them to resume you";
  }

  onAction(summary: string): void {
    this.viewer?.hooks.onAction(summary);
  }

  /** Stops the viewer, which frees the port for other sessions. The caller closes the Kiwi. */
  async close(): Promise<void> {
    this.closed = true;
    await this.pending?.catch(() => undefined);
    const viewer = this.viewer;
    this.viewer = undefined;
    await viewer?.close();
  }

  /** Concurrent tool calls share one attempt. */
  private run(force: boolean): Promise<Claim> {
    this.pending ??= this.acquire(force).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async acquire(force: boolean): Promise<Claim> {
    if (this.closed) return { blocked: "The Kiwi MCP server is shutting down." };
    if (await this.listen()) return { note: this.viewerNote() };

    const { port } = this.options;
    const owner = await this.fetchOwner();
    if (!owner) {
      return {
        blocked: `Port ${port} is taken by something other than a Kiwi agent session, so this session cannot use the Kiwi. Set KIWI_PORT to a free port in the MCP server's environment.`,
      };
    }
    if (owner.mode === "serve") {
      return {
        blocked: `A long-running Kiwi server (serve, pid ${owner.pid}) has the Kiwi. Connect to its MCP endpoint at ${this.base}/mcp instead, or stop that server.`,
      };
    }

    const idle = owner.viewers === 0 && (owner.idleMs ?? 0) >= this.options.handoverIdleMs;
    if (!force && !idle) {
      const watching = owner.viewers > 0 ? ", and someone has its live viewer open" : "";
      return {
        blocked: `Another agent session is using the Kiwi (pid ${owner.pid}, last used ${ago(Date.now() - (owner.idleMs ?? 0))}${watching}). Ask the user whether to take it over. If they agree, call take_over; the other session's tools stop working until it takes the Kiwi back.`,
      };
    }

    const refusal = await this.requestHandover();
    if (refusal) return { blocked: `The other agent session did not hand over the Kiwi: ${refusal}` };
    const deadline = Date.now() + HANDOVER_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this.listen()) {
        const from = force ? "" : `Took the Kiwi from an agent session that had been idle for ${duration(owner.idleMs ?? 0)}. `;
        return { note: from + this.viewerNote() };
      }
      await sleep(100);
    }
    return { blocked: `The other agent session let go of the Kiwi, but port ${port} did not free up in time. Try again.` };
  }

  /** Starts the viewer. False when the port is taken. */
  private async listen(): Promise<boolean> {
    try {
      this.viewer = await serve(this.kiwi, {
        port: this.options.port,
        autoResumeMs: this.options.autoResumeMs,
        mcp: false,
        handover: {
          idleMs: () => Date.now() - this.lastUsed,
          release: () => this.release(),
        },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
      throw err;
    }
    this.releasedAt = undefined;
    this.kiwi.link.resume();
    this.log(`this session has the Kiwi, live viewer at ${this.viewer.url}/`);
    return true;
  }

  /** Another session asked for the Kiwi: let go of the device. The viewer closes itself. */
  private async release(): Promise<void> {
    this.viewer = undefined;
    this.releasedAt = Date.now();
    this.log("another agent session took over the Kiwi");
    try {
      if (this.kiwi.link.isOpen) await Promise.race([this.kiwi.releaseAll(), sleep(500)]);
    } catch {
      // Best effort: nothing should stay pressed, but the device may be gone.
    }
    // A long type_text may still be running; suspending stops it from reopening the port.
    this.kiwi.video.stop();
    await this.kiwi.link.suspend("Another agent session took over the Kiwi").catch(() => undefined);
  }

  private async fetchOwner(): Promise<OwnerInfo | undefined> {
    try {
      const res = await localRequest(this.options.port, "GET", "/owner", 2_000);
      if (res.status !== 200) return undefined;
      const body = JSON.parse(res.body) as Partial<OwnerInfo> | null;
      return body?.app === "cytrence-kiwi" ? (body as OwnerInfo) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Asks the owner to let go. Returns why it refused, or undefined once it agreed or went away. */
  private async requestHandover(): Promise<string | undefined> {
    let res: LocalResponse;
    try {
      res = await localRequest(this.options.port, "POST", "/handover", HANDOVER_WAIT_MS);
    } catch {
      // The owner may have closed before answering. The port tells us either way.
      return undefined;
    }
    if (res.status === 200) return undefined;
    try {
      const { error } = JSON.parse(res.body) as { error?: unknown };
      if (typeof error === "string") return error;
    } catch {
      // Not JSON: fall back to the status below.
    }
    return `HTTP ${res.status}`;
  }

  private viewerNote(): string {
    return `The user can watch and take over in the live viewer at ${this.viewer?.url}/ (mention this link to them once).`;
  }
}

interface LocalResponse {
  status: number;
  body: string;
}

/**
 * One request to another session's viewer port on a fresh connection. `fetch` would pool
 * the socket, and after a handover a pooled socket points at a server that has closed.
 */
function localRequest(port: number, method: "GET" | "POST", path: string, timeoutMs: number): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: HOST,
        port,
        method,
        path,
        agent: false,
        timeout: timeoutMs,
        headers: method === "POST" ? { "Content-Type": "application/json", "Content-Length": 2 } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`No answer from port ${port} within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function ago(at: number): string {
  return `${duration(Date.now() - at)} ago`;
}
