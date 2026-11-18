#!/usr/bin/env node
/**
 * Manual test CLI. Uses the same Kiwi class as the MCP server.
 *
 *   kiwi info
 *   kiwi screenshot [out.jpg]
 *   kiwi move <x> <y>
 *   kiwi click <x> <y> [left|right|middle] [count] [modifiers]
 *   kiwi scroll <up|down|left|right> [amount] [x y]
 *   kiwi drag <x1> <y1> <x2> <y2>
 *   kiwi key <combo> [repeat]
 *   kiwi type <text>
 *   kiwi release
 *   kiwi hid-mode <normal|legacy>
 *
 * Coordinates are pixels in screenshot space (KIWI_SCREENSHOT_WIDTH wide, default 1280x720).
 */
import { writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { type ButtonName, Kiwi, type ScrollDirection } from "./kiwi.js";

const USAGE = `usage:
  kiwi info
  kiwi screenshot [out.jpg]
  kiwi move <x> <y>
  kiwi click <x> <y> [left|right|middle] [count] [modifiers]
  kiwi scroll <up|down|left|right> [amount] [x y]
  kiwi drag <x1> <y1> <x2> <y2>
  kiwi key <combo> [repeat]
  kiwi type <text>
  kiwi release
  kiwi hid-mode <normal|legacy>`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  const kiwi = new Kiwi({ ...loadConfig(), videoIdleMs: 0 });
  const num = (i: number) => {
    const value = Number(args[i]);
    if (!Number.isFinite(value)) throw new Error(`Argument ${i + 1} must be a number\n${USAGE}`);
    return value;
  };

  try {
    switch (command) {
      case "info": {
        const info = await kiwi.link.requestInfo();
        console.log(JSON.stringify({ serialPort: kiwi.link.path, ...info, logs: kiwi.link.recentLogs(5) }, null, 2));
        break;
      }
      case "screenshot": {
        const snap = await kiwi.screenshot();
        const out = args[0] ?? "screenshot.jpg";
        await writeFile(out, snap.jpeg);
        console.log(`${out} ${snap.width}x${snap.height} ${snap.jpeg.length} bytes`);
        break;
      }
      case "move":
        await kiwi.move(num(0), num(1));
        break;
      case "click":
        await kiwi.click({
          x: num(0),
          y: num(1),
          button: (args[2] as ButtonName | undefined) ?? "left",
          count: args[3] ? num(3) : 1,
          modifiers: args[4],
        });
        break;
      case "scroll":
        await kiwi.scroll({
          direction: args[0] as ScrollDirection,
          amount: args[1] ? num(1) : 3,
          x: args[2] ? num(2) : kiwi.screenSize.width / 2,
          y: args[3] ? num(3) : kiwi.screenSize.height / 2,
        });
        break;
      case "drag":
        await kiwi.drag({ fromX: num(0), fromY: num(1), toX: num(2), toY: num(3) });
        break;
      case "key":
        await kiwi.pressKeys(args[0] ?? "", { repeat: args[1] ? num(1) : 1 });
        break;
      case "type":
        console.log(`typed ${await kiwi.typeText(args.join(" "))} keystrokes`);
        break;
      case "release":
        await kiwi.releaseAll();
        break;
      case "hid-mode":
        if (args[0] !== "normal" && args[0] !== "legacy") throw new Error(`hid-mode needs "normal" or "legacy"\n${USAGE}`);
        await kiwi.setHidMode(args[0]);
        break;
      default:
        throw new Error(`Unknown command "${command}"\n${USAGE}`);
    }
  } finally {
    await kiwi.close();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
