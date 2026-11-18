#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { Kiwi } from "./kiwi.js";
import { DEFAULT_PORT, serve } from "./serve.js";
import { StdioSession } from "./session.js";
import { VERSION, createKiwiServer } from "./tools.js";

const USAGE = `cytrence-kiwi-mcp ${VERSION}

Usage:
  cytrence-kiwi-mcp [--port N]       MCP server on stdio (what an MCP client launches).
                                     Once the agent uses the Kiwi, a live viewer runs
                                     at http://127.0.0.1:${DEFAULT_PORT}/ until the session ends.
  cytrence-kiwi-mcp serve [--port N] Long-running server on http://127.0.0.1:${DEFAULT_PORT}:
                                     a live viewer you can click and type in at /,
                                     and a streamable HTTP MCP endpoint at /mcp

Environment variables are described in the README. KIWI_PORT also sets the port.`;

function parsePort(args: string[]): number {
  const i = args.indexOf("--port");
  const raw = i >= 0 ? args[i + 1] : process.env.KIWI_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port "${raw}"`);
  return port;
}

const argv = process.argv.slice(2);
const command = argv[0]?.startsWith("--port") ? undefined : argv[0];
const args = command === undefined ? argv : argv.slice(1);
if (command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (command !== undefined && command !== "serve") {
  console.error(`Unknown command "${command}"\n\n${USAGE}`);
  process.exit(1);
}

const config = loadConfig();
// A person watching wants smoother video than an agent taking screenshots needs.
if (command === "serve") config.streamFps ??= 20;
const kiwi = new Kiwi(config);
const cleanups: Array<() => Promise<void>> = [];

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  try {
    if (kiwi.link.isOpen) await Promise.race([kiwi.releaseAll(), new Promise((r) => setTimeout(r, 500))]);
  } catch {
    // Best effort: the device may already be gone.
  }
  await kiwi.close().catch(() => undefined);
  process.exit(code);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (command === "serve") {
  const port = parsePort(args);
  try {
    const running = await serve(kiwi, { port, autoResumeMs: config.autoResumeMs });
    cleanups.push(running.close);
    console.error(`[kiwi] cytrence-kiwi-mcp ${VERSION} serving`);
    console.error(`[kiwi]   viewer: ${running.url}/`);
    console.error(`[kiwi]   MCP:    ${running.url}/mcp`);
    console.error(`[kiwi]   add it: claude mcp add --transport http kiwi ${running.url}/mcp`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.error(
      e.code === "EADDRINUSE"
        ? `[kiwi] Port ${port} is already in use, by another serve or an agent session that has the Kiwi. Pick another with --port.`
        : `[kiwi] ${e.message}`,
    );
    await shutdown(1);
  }
} else {
  const session = new StdioSession(kiwi, {
    port: parsePort(args),
    autoResumeMs: config.autoResumeMs,
    handoverIdleMs: config.handoverIdleMs,
  });
  cleanups.push(() => session.close());
  // The MCP client owns our lifetime: when it closes stdin, we are done.
  process.stdin.on("close", () => void shutdown());
  await createKiwiServer(kiwi, session).connect(new StdioServerTransport());
  console.error(`[kiwi] cytrence-kiwi-mcp ${VERSION} ready on stdio`);
}
