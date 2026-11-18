/**
 * The live viewer served at `/` by `serve`. Self-contained on purpose: no build step,
 * no external assets. Video is an MJPEG <img>; input is posted to /input in order,
 * with pointer moves coalesced so a fast mouse never builds a backlog.
 */
export const VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cytrence Kiwi</title>
<style>
  :root { color-scheme: dark; --bg: #101214; --panel: #181b1f; --line: #2a2f36; --text: #e6e8eb; --dim: #8b939e; --accent: #7bd88f; --warn: #ffb454; --err: #ff6b6b; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, -apple-system, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
  header strong { font-size: 14px; }
  .pill { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); white-space: nowrap; }
  .pill.on { color: var(--accent); border-color: var(--accent); }
  .pill.paused { color: var(--warn); border-color: var(--warn); }
  button, select, input[type=text] { font: inherit; color: var(--text); background: #22262c; border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; }
  button { cursor: pointer; }
  button:hover { border-color: var(--dim); }
  button:disabled { opacity: .5; cursor: default; }
  #panelToggle { margin-left: auto; display: flex; align-items: center; padding: 4px 6px; color: var(--dim); }
  #panelToggle[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); }
  form { display: flex; gap: 4px; margin: 0; }
  input[type=text] { width: 150px; }
  input[hidden] { display: none; }
  label { display: flex; align-items: center; gap: 4px; color: var(--dim); }
  #msg { color: var(--dim); }
  #msg.err { color: var(--err); }
  main { flex: 1; display: flex; min-height: 0; }
  #stage { flex: 1; display: flex; align-items: center; justify-content: center; position: relative; min-width: 0; padding: 8px; outline: none; }
  #screen { display: block; max-width: 100%; max-height: calc(100vh - 72px); cursor: crosshair; user-select: none; -webkit-user-drag: none; touch-action: none; border: 2px solid transparent; border-radius: 4px; }
  #stage:focus #screen { border-color: var(--accent); }
  #overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: var(--dim); pointer-events: none; white-space: pre-line; }
  #overlay[hidden] { display: none; }
  aside { width: 280px; flex-shrink: 0; border-left: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; min-height: 0; }
  aside[hidden] { display: none; }
  aside h2 { margin: 0; padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--line); }
  #log { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
  #log li { padding: 6px 12px; border-bottom: 1px solid var(--line); }
  #log .who { font-weight: 600; margin-right: 6px; }
  #log .agent .who { color: var(--accent); }
  #log .you .who { color: var(--warn); }
  #log .system .who { color: var(--dim); }
  #log time { display: block; color: var(--dim); font-size: 11px; }
  .hint { color: var(--dim); font-size: 12px; padding: 8px 12px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<header>
  <strong>Cytrence Kiwi</strong>
  <span id="agent" class="pill">Agent: ...</span>
  <button id="pause" type="button">Pause agent</button>
  <label id="autoLabel" title="Pause the agent as soon as you click, scroll, or type in the viewer"><input id="auto" type="checkbox" checked> Take over when I use it</label>
  <form id="comboForm" title="Shortcuts your own computer would grab before the viewer sees them">
    <select id="combo">
      <option value="" disabled selected>Send keys...</option>
      <optgroup label="Windows">
        <option value="ctrl+alt+delete">Ctrl+Alt+Delete</option>
        <option value="win">Windows key</option>
        <option value="win+r">Win+R (Run)</option>
        <option value="win+d">Win+D (desktop)</option>
        <option value="win+l">Win+L (lock)</option>
        <option value="alt+tab">Alt+Tab</option>
        <option value="alt+f4">Alt+F4</option>
        <option value="ctrl+shift+escape">Ctrl+Shift+Esc (Task Manager)</option>
      </optgroup>
      <optgroup label="macOS">
        <option value="cmd+space">Cmd+Space (Spotlight)</option>
        <option value="cmd+tab">Cmd+Tab</option>
        <option value="cmd+q">Cmd+Q (quit app)</option>
        <option value="cmd+w">Cmd+W (close window)</option>
        <option value="cmd+option+escape">Cmd+Option+Esc (Force Quit)</option>
        <option value="ctrl+cmd+q">Ctrl+Cmd+Q (lock)</option>
      </optgroup>
      <optgroup label="Linux">
        <option value="super">Super key</option>
        <option value="ctrl+alt+t">Ctrl+Alt+T (terminal)</option>
        <option value="ctrl+alt+f2">Ctrl+Alt+F2 (console)</option>
      </optgroup>
      <optgroup label="Boot and BIOS">
        <option value="escape">Esc</option>
        <option value="delete">Delete</option>
        <option value="f2">F2</option>
        <option value="f8">F8</option>
        <option value="f10">F10</option>
        <option value="f11">F11</option>
        <option value="f12">F12</option>
      </optgroup>
      <option value="custom">Custom...</option>
    </select>
    <input id="customCombo" type="text" placeholder="e.g. ctrl+shift+t" autocomplete="off" hidden>
    <button>Send</button>
  </form>
  <button id="paste" type="button" title="Type the text on your clipboard into the target">Paste</button>
  <button id="release" type="button" title="Release every key and mouse button">Release all</button>
  <span id="msg"></span>
  <button id="panelToggle" type="button" aria-controls="panel" aria-expanded="false" aria-label="Activity" title="Show activity"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M10 2.75v10.5"/></svg></button>
</header>
<main>
  <div id="stage" tabindex="0">
    <img id="screen" alt="" draggable="false">
    <div id="overlay">Connecting to video...</div>
  </div>
  <aside id="panel" hidden>
    <h2>Activity</h2>
    <ol id="log"></ol>
    <div class="hint">Click the screen to capture your keyboard (green border). Shortcuts your own computer grabs first, like cmd+tab or ctrl+alt+delete, are in the Send keys menu.</div>
  </aside>
</main>
<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var img = $("screen"), stage = $("stage"), overlay = $("overlay");
  var status = { paused: false, autoPause: true };
  var videoUp = false;

  // ---- messages -------------------------------------------------------------
  var msgTimer = 0;
  function showMsg(text, isError, sticky) {
    var el = $("msg");
    el.textContent = text;
    el.className = isError ? "err" : "";
    clearTimeout(msgTimer);
    if (!sticky) msgTimer = setTimeout(function () { el.textContent = ""; }, 6000);
  }

  // ---- ordered input queue --------------------------------------------------
  var queue = [], sending = false;
  function enqueue(ev) {
    var last = queue[queue.length - 1];
    // Collapse runs of moves with the same buttons; a button change must never be dropped.
    if (ev.t === "pointer" && last && last.t === "pointer" && last.b === ev.b) queue[queue.length - 1] = ev;
    else queue.push(ev);
    if (!sending) flush();
  }
  function flush() {
    if (!queue.length) { sending = false; return; }
    sending = true;
    var events = queue.splice(0, queue.length);
    post("/input", { events: events }).then(flush, flush);
  }
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.error || r.statusText);
          return data;
        });
      })
      .catch(function (err) { showMsg(err.message || "Request failed", true); throw err; });
  }

  // ---- mouse ----------------------------------------------------------------
  var lastPos = { x: 0.5, y: 0.5 }, lastButtons = 0;
  function clamp(v) { return Math.min(1, Math.max(0, v)); }
  function frac(e) {
    var r = img.getBoundingClientRect();
    if (!r.width || !r.height) return lastPos;
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  }
  function pointer(e) {
    if (!videoUp) return;
    lastPos = frac(e);
    lastButtons = e.buttons & 31;
    enqueue({ t: "pointer", x: lastPos.x, y: lastPos.y, b: lastButtons });
  }
  img.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    stage.focus({ preventScroll: true });
    img.setPointerCapture(e.pointerId);
    pointer(e);
  });
  img.addEventListener("pointermove", pointer);
  img.addEventListener("pointerup", pointer);
  img.addEventListener("pointercancel", function () {
    lastButtons = 0;
    enqueue({ t: "pointer", x: lastPos.x, y: lastPos.y, b: 0 });
  });
  img.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  var accY = 0, accX = 0;
  img.addEventListener("wheel", function (e) {
    e.preventDefault();
    if (!videoUp) return;
    // Roughly one target wheel notch per mouse wheel click, accumulated for trackpads.
    var scale = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 10 : 1 / 100;
    accY += e.deltaY * scale;
    accX += e.deltaX * scale;
    var dy = Math.trunc(accY), dx = Math.trunc(accX);
    if (!dy && !dx) return;
    accY -= dy; accX -= dx;
    lastPos = frac(e);
    enqueue({ t: "wheel", x: lastPos.x, y: lastPos.y, dy: Math.max(-127, Math.min(127, dy)), dx: Math.max(-127, Math.min(127, dx)), b: e.buttons & 31 });
  }, { passive: false });

  // ---- keyboard -------------------------------------------------------------
  var held = new Set();
  var MODIFIER = /^(Shift|Control|Alt|Meta|OS)(Left|Right)$/;
  function sendKeys() { enqueue({ t: "keys", codes: Array.from(held) }); }
  stage.addEventListener("keydown", function (e) {
    if (!e.code) return;
    e.preventDefault();
    if (e.repeat) return; // The target repeats held keys itself.
    held.add(e.code);
    sendKeys();
    // While cmd is held, macOS browsers never fire keyup for other keys, so tap them now.
    if (e.metaKey && !MODIFIER.test(e.code)) { held.delete(e.code); sendKeys(); }
  });
  stage.addEventListener("keyup", function (e) {
    if (!e.code) return;
    e.preventDefault();
    if (!held.delete(e.code)) return;
    sendKeys();
  });
  stage.addEventListener("blur", function () {
    if (held.size) { held.clear(); sendKeys(); }
    if (lastButtons) { lastButtons = 0; enqueue({ t: "pointer", x: lastPos.x, y: lastPos.y, b: 0 }); }
  });

  // ---- toolbar --------------------------------------------------------------
  $("pause").addEventListener("click", function () { post("/control", { paused: !status.paused }).catch(function () {}); });
  $("auto").addEventListener("change", function (e) { post("/control", { autoPause: e.target.checked }).catch(function () {}); });
  $("release").addEventListener("click", function () { held.clear(); lastButtons = 0; enqueue({ t: "release" }); });
  $("combo").addEventListener("change", function (e) {
    var custom = e.target.value === "custom";
    $("customCombo").hidden = !custom;
    if (custom) $("customCombo").focus();
  });
  $("comboForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var combo = $("combo").value === "custom" ? $("customCombo").value.trim() : $("combo").value;
    if (combo) enqueue({ t: "combo", combo: combo });
  });

  // ---- paste ------------------------------------------------------------------
  // The browser may ask for clipboard permission the first time. If it won't
  // share the clipboard at all, fall back to a box you paste into yourself.
  function readClipboard() {
    var ask = function (why) { return window.prompt(why + "Paste the text to type on the target:"); };
    if (!navigator.clipboard || !navigator.clipboard.readText) return Promise.resolve(ask(""));
    return navigator.clipboard.readText().catch(function () { return ask("The browser didn't share the clipboard. "); });
  }
  $("paste").addEventListener("click", function () {
    var btn = $("paste");
    btn.disabled = true;
    readClipboard().then(function (text) {
      stage.focus({ preventScroll: true });
      if (text === null) return; // Cancelled.
      if (!text) { showMsg("Nothing to paste"); return; }
      showMsg("Typing " + text.length + " characters...", false, true);
      return post("/input", { events: [{ t: "paste", text: text }] }).then(function () { showMsg("Pasted"); });
    }).catch(function () {}).then(function () { btn.disabled = false; });
  });

  // ---- activity panel ---------------------------------------------------------
  var panel = $("panel"), panelToggle = $("panelToggle");
  function setPanel(open) {
    panel.hidden = !open;
    panelToggle.setAttribute("aria-expanded", String(open));
    panelToggle.title = open ? "Hide activity" : "Show activity";
    try { localStorage.setItem("kiwi.activityPanel", open ? "open" : "closed"); } catch (e) {}
  }
  try { if (localStorage.getItem("kiwi.activityPanel") === "open") setPanel(true); } catch (e) {}
  panelToggle.addEventListener("click", function () { setPanel(panel.hidden); });

  // ---- status and activity --------------------------------------------------
  // After a takeover the server hands control back once you go idle; count down to it.
  var resumeDeadline = 0;
  function renderAgentPill() {
    var pill = $("agent");
    var text = status.paused ? "Agent: paused" : "Agent: active";
    if (status.paused && resumeDeadline) {
      text += ", back in " + Math.max(0, Math.ceil((resumeDeadline - Date.now()) / 1000)) + " s";
    }
    pill.textContent = text;
    pill.className = "pill " + (status.paused ? "paused" : "on");
  }
  setInterval(function () { if (resumeDeadline) renderAgentPill(); }, 250);
  function applyStatus(s) {
    status = s;
    resumeDeadline = s.paused && typeof s.resumeInMs === "number" ? Date.now() + s.resumeInMs : 0;
    renderAgentPill();
    $("pause").textContent = s.paused ? "Resume agent" : "Pause agent";
    $("auto").checked = !!s.autoPause;
    $("autoLabel").title = "Pause the agent as soon as you click, scroll, or type in the viewer." +
      (s.autoResumeMs > 0 ? " It gets control back after " + Math.round(s.autoResumeMs / 1000) + " s without input from you." : "");
    if (!videoUp && s.videoError) { overlay.hidden = false; overlay.textContent = "Video unavailable:\n" + s.videoError + "\n\nRetrying..."; }
  }
  var WHO = { agent: "Agent", you: "You", system: "Server" };
  function addLog(entry) {
    var li = document.createElement("li");
    li.className = entry.who;
    var who = document.createElement("span");
    who.className = "who";
    who.textContent = WHO[entry.who] || entry.who;
    var time = document.createElement("time");
    time.textContent = new Date(entry.at).toLocaleTimeString();
    li.appendChild(who);
    li.appendChild(document.createTextNode(entry.text));
    li.appendChild(time);
    var list = $("log");
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 200) list.removeChild(list.lastChild);
  }
  var events = new EventSource("/events");
  events.addEventListener("status", function (e) { applyStatus(JSON.parse(e.data)); });
  events.addEventListener("log", function (e) { addLog(JSON.parse(e.data)); });
  events.addEventListener("error", function () { showMsg("Lost connection to the server, retrying...", true); });

  // ---- video ----------------------------------------------------------------
  var retryTimer = 0;
  function connectVideo() {
    clearTimeout(retryTimer);
    img.src = "/stream.mjpg?t=" + Date.now();
  }
  function markVideoUp() { videoUp = true; overlay.hidden = true; }
  img.addEventListener("load", markVideoUp);
  // Not every browser fires load for a multipart stream, so also watch for the first frame.
  setInterval(function () { if (!videoUp && img.naturalWidth > 0) markVideoUp(); }, 500);
  img.addEventListener("error", function () {
    videoUp = false;
    overlay.hidden = false;
    if (!status.videoError) overlay.textContent = "Video unavailable, retrying...";
    retryTimer = setTimeout(connectVideo, 3000);
  });
  connectVideo();
})();
</script>
</body>
</html>
`;
