import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Kiwi } from "../src/kiwi.js";
import { FULL_FRAME, findActiveArea } from "../src/video.js";

const W = 1280;
const H = 720;

/** A gray frame that is black except for a filled rectangle of `luma`. */
function frame(left: number, top: number, right: number, bottom: number, luma = 120): Uint8Array {
  const gray = new Uint8Array(W * H).fill(4);
  for (let y = top; y <= bottom; y++) gray.fill(luma, y * W + left, y * W + right + 1);
  return gray;
}

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("findActiveArea finds the picture between pillarbox bars", () => {
  // Matches a real capture: a 16:10 Mac screen centred in a 1280x720 frame.
  const area = findActiveArea(frame(85, 0, 1193, H - 1), W, H);
  assert.ok(area);
  close(area.x, 85 / W);
  close(area.width, 1109 / W);
  close(area.y, 0);
  close(area.height, 1);
});

test("findActiveArea treats a picture that fills the frame as no bars", () => {
  assert.deepEqual(findActiveArea(frame(0, 0, W - 1, H - 1), W, H), { ...FULL_FRAME });
  // A couple of dark columns at the very edge are JPEG fuzz, not a bar.
  assert.deepEqual(findActiveArea(frame(2, 1, W - 3, H - 2), W, H), { ...FULL_FRAME });
});

test("findActiveArea gives up on dark frames instead of guessing", () => {
  assert.equal(findActiveArea(new Uint8Array(W * H), W, H), undefined);
  assert.equal(findActiveArea(frame(600, 300, 700, 400), W, H), undefined);
});

test("mouse coordinates map inside the picture, not the whole frame", () => {
  process.env.KIWI_SERIAL_PORT = "/dev/does-not-exist";
  const kiwi = new Kiwi(loadConfig());
  assert.deepEqual(kiwi.toAbs(0, 0), { x: 12, y: 22 });

  const area = findActiveArea(frame(85, 0, 1193, H - 1), W, H)!;
  Object.defineProperty(kiwi.video, "activeArea", { get: () => area });
  // The middle of the picture is the middle of the target's screen.
  assert.equal(kiwi.toAbs(639, 360).x, 16384);
  // The picture's edges are the screen's edges; points on a bar clamp to them.
  assert.equal(kiwi.toAbs(85, 360).x, 14);
  assert.equal(kiwi.toAbs(40, 360).x, 0);
  assert.equal(kiwi.toAbs(1250, 360).x, 32767);
});
