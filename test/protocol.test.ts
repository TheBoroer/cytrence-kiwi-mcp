import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChord, textToKeystrokes, Modifier } from "../src/keys.js";
import {
  FrameDecoder,
  INFO_REQUEST_BODY,
  MsgType,
  absoluteMouseReport,
  crc8,
  encodeFrame,
  keyboardReport,
  parseKiwiInfo,
  parseLogMessage,
  relativeMouseReport,
} from "../src/protocol.js";

// Frames produced by the Python probe that was verified against real hardware.
const REFERENCE = {
  info: "3c5aa5c300150000c80002000100c96dd69c",
  abs: "3c5aa5c3004e01009b01070000004000400000c96dd69c",
  rel: "3c5aa5c300a302009a010500001e000000c96dd69c",
  kbd: "3c5aa5c3004866009001080008002c0000000000c96dd69c",
};

// A log frame the Kiwi actually sent back ("Msg: To respond with kiwi info", NUL-terminated).
const DEVICE_LOG_FRAME =
  "3c5aa5c3002b25002c01210002004d73673a20546f20726573706f6e642077697468206b69776920696e666f00c96dd69c";

test("crc8 matches the device", () => {
  const frame = Buffer.from(DEVICE_LOG_FRAME, "hex");
  const body = frame.subarray(12, frame.length - 4);
  assert.equal(crc8(body), 0x2b);
  assert.equal(crc8(Buffer.alloc(0)), 0);
});

test("encodeFrame reproduces hardware-verified frames", () => {
  assert.equal(encodeFrame(MsgType.InfoRequest, INFO_REQUEST_BODY, 0).toString("hex"), REFERENCE.info);
  assert.equal(encodeFrame(MsgType.AbsoluteMouse, absoluteMouseReport(0, 16384, 16384), 1).toString("hex"), REFERENCE.abs);
  assert.equal(encodeFrame(MsgType.RelativeMouse, relativeMouseReport(0, 30, 0), 2).toString("hex"), REFERENCE.rel);
  assert.equal(
    encodeFrame(MsgType.Keyboard, keyboardReport(Modifier.LeftGui, [0x2c]), 102).toString("hex"),
    REFERENCE.kbd,
  );
});

test("decoder handles split chunks, garbage, and back-to-back frames", () => {
  const log = Buffer.from(DEVICE_LOG_FRAME, "hex");
  const info = Buffer.from(REFERENCE.info, "hex");
  const stream = Buffer.concat([Buffer.from([0x00, 0x3c, 0x5a]), log, Buffer.from([0xff]), info]);
  const decoder = new FrameDecoder();
  const frames = [];
  for (let i = 0; i < stream.length; i += 7) frames.push(...decoder.push(stream.subarray(i, i + 7)));

  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.type, MsgType.Log);
  assert.equal(frames[0]!.seq, 0x25);
  assert.ok(frames[0]!.crcOk);
  assert.deepEqual(parseLogMessage(frames[0]!.body), { level: 2, text: "Msg: To respond with kiwi info" });
  assert.equal(frames[1]!.type, MsgType.InfoRequest);
});

test("decoder flags bad CRC but keeps framing", () => {
  const bad = Buffer.from(REFERENCE.kbd, "hex");
  bad[5] ^= 0xff;
  const [frame] = new FrameDecoder().push(bad);
  assert.equal(frame?.crcOk, false);
});

// A real 0x64 KiwiInfo body (Kiwi v1.1/B, firmware 2.10, boot 2.8). Bytes 4..11 are the unit's flash
// unique ID, replaced with a placeholder that keeps byte 0x0b printable ("7") like the real one.
const REAL_INFO_BODY =
  "01000400deadbeefcafe00374b697769202876312e312f42290000000000000000000000000000000000000020000000" +
  "0000000000000000000000000000000000000000000000000000000002000800323032362e30332e30325432333a3036" +
  "3a33345a0002000a00323032362e30372e31375431373a35363a32305a00010000000000";

test("parseKiwiInfo reads model, versions, and builds from a real reply", () => {
  const body = Buffer.from(REAL_INFO_BODY, "hex");
  assert.equal(body.length, 132);
  const info = parseKiwiInfo(body);
  // Byte 0x0b is 0x37 ("7") and must not leak into the model string.
  assert.equal(info.model, "Kiwi (v1.1/B)");
  assert.equal(info.firmwareVersion, "2.10");
  assert.equal(info.firmwareBuild, "2026.07.17T17:56:20Z");
  assert.equal(info.bootVersion, "2.8");
  assert.equal(info.bootBuild, "2026.03.02T23:06:34Z");
  assert.deepEqual(info.firmwareBuilds, ["2026.03.02T23:06:34Z", "2026.07.17T17:56:20Z"]);
});

test("parseKiwiInfo degrades gracefully on short bodies", () => {
  const info = parseKiwiInfo(Buffer.from("0100", "hex"));
  assert.equal(info.model, "unknown");
  assert.equal(info.firmwareVersion, undefined);
});

test("mouse reports clamp out-of-range values", () => {
  assert.deepEqual([...absoluteMouseReport(1, -5, 99999, 500, -500)], [1, 0, 0, 0xff, 0x7f, 127, 0x81]);
  assert.deepEqual([...relativeMouseReport(0, 300, -300)], [0, 127, 0x81, 0, 0]);
});

test("parseChord understands modifiers, aliases, and characters", () => {
  assert.deepEqual(parseChord("cmd+space"), { modifiers: Modifier.LeftGui, keys: [0x2c] });
  assert.deepEqual(parseChord("Ctrl+Shift+T"), { modifiers: Modifier.LeftCtrl | Modifier.LeftShift, keys: [0x17] });
  assert.deepEqual(parseChord("enter"), { modifiers: 0, keys: [0x28] });
  assert.deepEqual(parseChord("shift"), { modifiers: Modifier.LeftShift, keys: [] });
  assert.deepEqual(parseChord("f12"), { modifiers: 0, keys: [0x45] });
  assert.deepEqual(parseChord("page_down"), { modifiers: 0, keys: [0x4e] });
  assert.deepEqual(parseChord("cmd+/"), { modifiers: Modifier.LeftGui, keys: [0x38] });
  assert.throws(() => parseChord("cmd+banana"), /Unknown key/);
  assert.throws(() => parseChord("cmd++"), /Invalid key combo/);
});

test("textToKeystrokes maps US layout and reports unsupported characters", () => {
  const { strokes, unsupported } = textToKeystrokes("Hi!\n");
  assert.deepEqual(
    strokes.map((s) => [s.key, s.modifiers]),
    [
      [0x0b, Modifier.LeftShift],
      [0x0c, 0],
      [0x1e, Modifier.LeftShift],
      [0x28, 0],
    ],
  );
  assert.deepEqual(unsupported, []);
  assert.deepEqual(textToKeystrokes("café ✓").unsupported, ["é", "✓"]);
});
