import assert from "node:assert/strict";
import { createServer } from "node:http";
import { before, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Kiwi } from "../src/kiwi.js";
import { type OwnerInfo, serve } from "../src/serve.js";
import { StdioSession } from "../src/session.js";

// No hardware here: point the serial port and ffmpeg at things that do not exist.
before(() => {
  process.env.KIWI_SERIAL_PORT = "/dev/does-not-exist";
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
});

/** A port that was free a moment ago. Sessions need a fixed port, since it is their lock. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.ok(address && typeof address === "object");
  return address.port;
}

function session(port: number, handoverIdleMs = 600_000): StdioSession {
  return new StdioSession(new Kiwi(loadConfig()), { port, handoverIdleMs, log: () => undefined });
}

test("a stdio session claims the Kiwi on first use and shares the viewer link once", async () => {
  const port = await freePort();
  const a = session(port);
  try {
    const first = await a.claim();
    assert.equal(first.blocked, undefined);
    assert.match(first.note ?? "", new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
    assert.deepEqual(await a.claim(), {});

    const owner = (await (await fetch(`http://127.0.0.1:${port}/owner`)).json()) as OwnerInfo;
    assert.equal(owner.app, "cytrence-kiwi");
    assert.equal(owner.mode, "stdio");
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.viewers, 0);

    const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
    assert.equal(mcp.status, 404);
  } finally {
    await a.close();
  }
});

test("a second session has to ask before taking a busy Kiwi, and can take it back", async () => {
  const port = await freePort();
  const a = session(port);
  const b = session(port);
  try {
    await a.claim();

    const busy = await b.claim();
    assert.match(busy.blocked ?? "", /Another agent session is using the Kiwi/);
    assert.match(busy.blocked ?? "", /take_over/);

    assert.match(await b.takeOver(), /has the Kiwi now.*live viewer/);
    const lost = await a.claim();
    assert.match(lost.blocked ?? "", /Another agent session took over the Kiwi/);
    assert.equal(a.isPaused(), false);

    assert.match(await a.takeOver(), /has the Kiwi now/);
    assert.match((await b.claim()).blocked ?? "", /took over the Kiwi/);
    assert.match(await a.takeOver(), /already has the Kiwi/);
  } finally {
    await a.close();
    await b.close();
  }
});

test("an idle session hands the Kiwi over without asking, unless a viewer is open", async () => {
  const port = await freePort();
  const a = session(port);
  const b = session(port, 0);
  const events = new AbortController();
  try {
    await a.claim();

    const page = await fetch(`http://127.0.0.1:${port}/events`, { signal: events.signal });
    assert.equal(page.status, 200);
    assert.match((await b.claim()).blocked ?? "", /someone has its live viewer open/);

    events.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const handed = await b.claim();
    assert.equal(handed.blocked, undefined);
    assert.match(handed.note ?? "", /idle/);
    assert.match((await a.claim()).blocked ?? "", /took over the Kiwi/);
  } finally {
    events.abort();
    await a.close();
    await b.close();
  }
});

test("only another Kiwi session can ask for a handover, not a web page", async () => {
  const port = await freePort();
  const a = session(port);
  try {
    await a.claim();
    const url = `http://127.0.0.1:${port}/handover`;
    const fromPage = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: "{}",
    });
    assert.equal(fromPage.status, 403);
    const simple = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(simple.status, 415);
    assert.deepEqual(await a.claim(), {});
  } finally {
    await a.close();
  }
});

test("a session will not take the Kiwi from serve or from an unrelated program", async () => {
  const port = await freePort();
  const b = session(port, 0);

  const served = await serve(new Kiwi(loadConfig()), { port });
  try {
    assert.match((await b.claim()).blocked ?? "", /long-running Kiwi server/);
    const handover = await fetch(`${served.url}/handover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(handover.status, 404);
  } finally {
    await served.close();
  }

  const other = createServer((_req, res) => res.writeHead(404).end());
  await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
  try {
    assert.match((await b.claim()).blocked ?? "", /taken by something other than a Kiwi/);
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
    await b.close();
  }
});
