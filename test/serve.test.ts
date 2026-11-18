import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { Kiwi, MAX_TEXT_LENGTH } from "../src/kiwi.js";
import { Modifier, chordFromCodes, parseChord } from "../src/keys.js";
import { type RunningServer, serve } from "../src/serve.js";
import { loadConfig } from "../src/config.js";
import { VIEWER_HTML } from "../src/viewer.js";

test("chordFromCodes maps browser key codes to the same HID usages as parseChord", () => {
  assert.deepEqual(chordFromCodes(["MetaLeft", "Space"]), parseChord("cmd+space"));
  assert.deepEqual(chordFromCodes(["ControlLeft", "ShiftLeft", "KeyT"]), parseChord("ctrl+shift+t"));
  assert.deepEqual(chordFromCodes(["Digit1", "Digit0", "F12", "ArrowDown", "Enter"]), {
    modifiers: 0,
    keys: [0x1e, 0x27, 0x45, 0x51, 0x28],
  });
  assert.deepEqual(chordFromCodes(["ShiftRight", "AltRight"]), {
    modifiers: Modifier.RightShift | Modifier.RightAlt,
    keys: [],
  });
});

test("chordFromCodes ignores unknown codes and caps at six keys", () => {
  assert.deepEqual(chordFromCodes(["Fn", "KeyA", "KeyA"]), { modifiers: 0, keys: [0x04] });
  const many = chordFromCodes(["KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG"]);
  assert.equal(many.keys.length, 6);
});

// No hardware here: point the serial port and ffmpeg at things that do not exist.
let running: RunningServer;
before(async () => {
  process.env.KIWI_SERIAL_PORT = "/dev/does-not-exist";
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
  running = await serve(new Kiwi(loadConfig()), { port: 0 });
});
after(() => running.close());

test("serve picks a free port when asked for port 0", () => {
  assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(running.url.endsWith(":0"), true);
});

test("serve answers the viewer page and rejects foreign hosts", async () => {
  const page = await fetch(`${running.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cytrence Kiwi/);

  // fetch silently drops a custom Host header, so use node:http to send a rebinding-style request.
  const rebound = await new Promise<number>((resolve, reject) => {
    const req = request(`${running.url}/`, { headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(rebound, 403);

  const crossSite = await fetch(`${running.url}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(crossSite.status, 403);
});

test("serve exposes the Kiwi tools over streamable HTTP MCP", async () => {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const init = await fetch(`${running.url}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
  assert.equal(init.status, 200, await init.clone().text());
  assert.match(await init.text(), /cytrence-kiwi/);

  const list = await fetch(`${running.url}/mcp`, {
    method: "POST",
    headers: { ...headers, "Mcp-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const text = await list.text();
  assert.equal(list.status, 200, text);
  for (const name of ["screenshot", "click", "type_text", "press_keys", "open_viewer"]) assert.match(text, new RegExp(`"${name}"`));
});

test("device_info reports the viewer link, and open_viewer leaves an open viewer alone", async () => {
  const callTool = async (name: string) => {
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name, arguments: {} } }),
    });
    const body = await res.text();
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    const result = JSON.parse(data ? data.slice(6) : body).result as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError ?? false, text: result.content.map((c) => c.text).join("\n") };
  };

  // No Kiwi answers here, so the model is unavailable, but the rest still comes back.
  const info = await callTool("device_info");
  assert.equal(info.isError, false, info.text);
  const details = JSON.parse(info.text) as { viewer: string; model: string };
  assert.equal(details.viewer, `${running.url}/`);
  assert.match(details.model, /^unavailable/);

  // An open viewer tab means open_viewer must not launch a browser.
  const events = new AbortController();
  const tab = await fetch(`${running.url}/events`, { signal: events.signal });
  try {
    const opened = await callTool("open_viewer");
    assert.equal(opened.isError, false, opened.text);
    assert.match(opened.text, /already open in a browser tab/);
  } finally {
    events.abort();
    await tab.body?.cancel().catch(() => undefined);
  }
});

test("every key combo in the viewer's Send keys menu parses", () => {
  const combos = [...VIEWER_HTML.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter((v) => v && v !== "custom");
  assert.ok(combos.length > 10);
  for (const combo of combos) assert.doesNotThrow(() => parseChord(combo), combo);
});

test("pausing from the viewer blocks agent input tools", async () => {
  const post = (path: string, body: unknown) =>
    fetch(`${running.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });

  const paused = await post("/control", { paused: true });
  assert.equal(paused.status, 200);
  assert.equal(((await paused.json()) as { paused: boolean }).paused, true);

  const call = await fetch(`${running.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "press_keys", arguments: { keys: "enter" } },
    }),
  });
  const text = await call.text();
  assert.match(text, /Agent input is paused/);
  assert.match(text, /"isError":true/);

  await post("/control", { paused: false });
});

test("viewer input reports device errors instead of crashing", async () => {
  const res = await fetch(`${running.url}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: [{ t: "keys", codes: [] }] }),
  });
  assert.equal(res.status, 502);
  assert.ok(((await res.json()) as { error: string }).error.length > 0);

  const bad = await fetch(`${running.url}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: [{ t: "explode" }] }),
  });
  assert.equal(bad.status, 400);
});

test("Paste in the viewer types the clipboard and keeps the agent waiting until it is done", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const kiwi = new Kiwi(loadConfig());
  const typed: string[] = [];
  kiwi.typeText = async (text: string) => {
    await sleep(600);
    typed.push(text);
    return text.length;
  };
  const quick = await serve(kiwi, { port: 0, autoResumeMs: 200 });
  try {
    type Status = { paused: boolean; resumeInMs: number | null };
    const post = async (path: string, body: unknown) =>
      fetch(`${quick.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const status = async () => (await (await post("/control", {})).json()) as Status;
    const paste = (text: string) => post("/input", { events: [{ t: "paste", text }] });

    // Text the Kiwi can't type is refused whole, and doesn't count as taking over.
    const refused: Array<[string, RegExp]> = [
      ["", /Nothing to paste/],
      ["it’s", /Nothing was pasted/],
      ["x".repeat(MAX_TEXT_LENGTH + 1), /limit/],
    ];
    for (const [text, pattern] of refused) {
      const res = await paste(text);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, pattern);
    }
    assert.equal((await status()).paused, false);

    // A paste outlasting the idle window doesn't hand control back halfway through.
    const pasting = paste("hello\nworld");
    await sleep(400);
    assert.equal((await status()).paused, true);
    assert.equal((await pasting).status, 200);
    assert.deepEqual(typed, ["hello\nworld"]);
    const s = await status();
    assert.equal(s.paused, true);
    assert.ok(s.resumeInMs !== null && s.resumeInMs > 0);

    await sleep(350);
    assert.equal((await status()).paused, false);
  } finally {
    await quick.close();
  }
});

test("taking over in the viewer hands control back after you go idle", async () => {
  const quick = await serve(new Kiwi(loadConfig()), { port: 0, autoResumeMs: 300 });
  try {
    type Status = { paused: boolean; resumeInMs: number | null };
    const post = async (path: string, body: unknown) =>
      fetch(`${quick.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const status = async () => (await (await post("/control", {})).json()) as Status;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // No device here, so the input itself fails, but the takeover still counts.
    await post("/input", { events: [{ t: "keys", codes: ["KeyA"] }] });
    let s = await status();
    assert.equal(s.paused, true);
    assert.ok(s.resumeInMs !== null && s.resumeInMs > 0 && s.resumeInMs <= 300);

    // Moving the mouse while paused keeps the agent waiting.
    await sleep(200);
    await post("/input", { events: [{ t: "pointer", x: 0.5, y: 0.5, b: 0 }] });
    await sleep(200);
    assert.equal((await status()).paused, true);

    await sleep(300);
    s = await status();
    assert.equal(s.paused, false);
    assert.equal(s.resumeInMs, null);

    // A pause from the button waits for Resume.
    await post("/control", { paused: true });
    await sleep(400);
    s = await status();
    assert.equal(s.paused, true);
    assert.equal(s.resumeInMs, null);
  } finally {
    await quick.close();
  }
});
