import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { type Kiwi, MAX_TEXT_LENGTH } from "./kiwi.js";
import type { Snapshot } from "./video.js";
import { openInBrowser } from "./browser.js";

// package.json is the single source of truth for the version. It sits one
// level above both src/tools.ts (tsx) and dist/tools.js (built).
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = { isError?: boolean; content: Content[] };

/** Outcome of asking for the Kiwi before a tool runs. */
export interface Claim {
  /** Stops the tool with this message, e.g. when another agent session has the Kiwi. */
  blocked?: string;
  /** Extra line for the tool result, e.g. the live viewer link the first time. */
  note?: string;
}

/** The live viewer this session runs. */
export interface ViewerInfo {
  /** Viewer page, e.g. http://127.0.0.1:7523/ */
  url: string;
  /** Browser tabs that currently have the viewer open. */
  tabs: number;
}

/** Lets the live viewer pause agent input and see what the agent is doing. */
export interface AgentHooks {
  /** The live viewer, when this session has one. Adds the `open_viewer` tool when present. */
  viewerInfo?(): ViewerInfo | undefined;
  /** Runs before every tool, so a stdio session can claim the Kiwi from other sessions. */
  claim?(): Promise<Claim>;
  /** Takes the Kiwi from another agent session. Adds the `take_over` tool when present. */
  takeOver?(): Promise<string>;
  /** True while a person has paused agent input from the viewer. */
  isPaused(): boolean;
  /** While paused: tells the agent how long to wait, e.g. "Wait for them to resume you". */
  pausedHint?(): string;
  /** Called with a one-line summary after each successful agent input action. */
  onAction(summary: string): void;
}

const coord = (axis: "x" | "y") =>
  z
    .number()
    .min(0)
    .describe(`${axis === "x" ? "Horizontal" : "Vertical"} pixel position in the latest screenshot`);
const screenshotFlag = z
  .boolean()
  .optional()
  .describe("Return a screenshot after the action once the UI has settled (default false)");
const button = z.enum(["left", "right", "middle", "back", "forward"]).optional().describe("Mouse button (default left)");

const inputAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** Builds an MCP server exposing the Kiwi tools. Cheap enough to call once per HTTP request. */
export function createKiwiServer(kiwi: Kiwi, hooks?: AgentHooks): McpServer {
  const server = new McpServer(
    { name: "cytrence-kiwi", version: VERSION },
    {
      instructions: [
        "Controls a separate physical computer through a Cytrence Kiwi KVM: you see its HDMI output and drive a USB keyboard and mouse.",
        "Start with `screenshot`. All x/y coordinates are pixels in the most recent screenshot (default 1280x720), origin top-left.",
        "Input actions accept `screenshot: true` to return a fresh capture after the UI settles, which saves a round trip.",
        "Typing assumes a US keyboard layout on the target. Use `press_keys` for shortcuts (e.g. cmd+space on macOS, ctrl+l on Windows/Linux).",
        "There is no feedback channel besides the video, so verify each step with a screenshot before relying on it.",
        ...(hooks
          ? [
              "A person may be watching and using the same screen from a live viewer. If an input tool says agent input is paused, stop sending input and wait for them, then take a fresh screenshot before continuing.",
            ]
          : []),
        ...(hooks?.takeOver
          ? [
              "When a tool result includes the live viewer link, pass it on to the user once so they know they can watch.",
              "Only one agent session can use the Kiwi at a time. If a tool says another session has it, ask the user before calling `take_over`.",
            ]
          : []),
        ...(hooks?.viewerInfo
          ? [
              "If the user wants to watch or help, or has to do something on the target themselves (a password, a 2FA prompt), call `open_viewer` to open the live viewer in their browser.",
            ]
          : []),
      ].join("\n"),
    },
  );

  function errorResult(message: string): ToolResult {
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  /** Claims the Kiwi before `run`, so no tool touches it while another session has it. */
  async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
    let claim: Claim = {};
    try {
      claim = (await hooks?.claim?.()) ?? {};
    } catch (err) {
      return errorResult(`Could not get the Kiwi: ${(err as Error).message}`);
    }
    if (claim.blocked) return errorResult(claim.blocked);
    const result = await run();
    if (claim.note) result.content.push({ type: "text", text: claim.note });
    return result;
  }

  function snapshotContent(snap: Snapshot): Content[] {
    return [
      { type: "image", data: snap.jpeg.toString("base64"), mimeType: "image/jpeg" },
      { type: "text", text: `Screenshot ${snap.width}x${snap.height}${cursorNote()}` },
    ];
  }

  function cursorNote(): string {
    const c = kiwi.cursor;
    return c ? `, cursor last placed at (${c.x}, ${c.y})` : "";
  }

  /** Runs an input action, then optionally attaches a settled screenshot. Errors become tool errors. */
  function act(summary: () => Promise<string>, withScreenshot: boolean | undefined): Promise<ToolResult> {
    return guarded(async () => {
      if (hooks?.isPaused()) {
        return errorResult(
          `Agent input is paused: the person at the live viewer has taken over. Nothing was sent. ${hooks.pausedHint?.() ?? "Wait for them to resume you"}, then take a fresh screenshot.`,
        );
      }
      try {
        const text = await summary();
        hooks?.onAction(text);
        const content: Content[] = [{ type: "text", text }];
        if (withScreenshot) content.push(...snapshotContent(await kiwi.screenshotAfterSettle()));
        return { content };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    });
  }

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Capture the target computer's screen from the Kiwi's HDMI input. Returns a JPEG; use its pixel coordinates for every mouse tool.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guarded(async () => {
        try {
          return { content: snapshotContent(await kiwi.screenshot()) };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }),
  );

  server.registerTool(
    "mouse_move",
    {
      title: "Move mouse",
      description: "Move the pointer to (x, y) without clicking, e.g. to hover over a menu or tooltip.",
      inputSchema: z.object({ x: coord("x"), y: coord("y"), screenshot: screenshotFlag }),
      annotations: { ...inputAnnotations, destructiveHint: false, idempotentHint: true },
    },
    async ({ x, y, screenshot }) =>
      act(async () => {
        await kiwi.move(x, y);
        return `Moved pointer to (${x}, ${y})`;
      }, screenshot),
  );

  server.registerTool(
    "click",
    {
      title: "Click",
      description:
        "Click at (x, y). Set count 2 for a double-click or 3 for a triple-click. `modifiers` holds keys during the click, e.g. \"cmd\" or \"shift\". Omit x and y to click at the current pointer position.",
      inputSchema: z.object({
        x: coord("x").optional(),
        y: coord("y").optional(),
        button,
        count: z.number().int().min(1).max(3).optional().describe("Number of clicks (default 1)"),
        modifiers: z.string().optional().describe('Modifier keys to hold, joined with "+", e.g. "cmd" or "ctrl+shift"'),
        screenshot: screenshotFlag,
      }),
      annotations: inputAnnotations,
    },
    async ({ x, y, button, count, modifiers, screenshot }) =>
      act(async () => {
        await kiwi.click({ x, y, button, count, modifiers });
        const where = x !== undefined && y !== undefined ? `(${x}, ${y})` : "the current position";
        const kind = count === 2 ? "Double-clicked" : count === 3 ? "Triple-clicked" : "Clicked";
        return `${kind} ${button ?? "left"} at ${where}${modifiers ? ` holding ${modifiers}` : ""}`;
      }, screenshot),
  );

  server.registerTool(
    "drag",
    {
      title: "Drag",
      description: "Press a mouse button at (from_x, from_y), move smoothly to (to_x, to_y), and release. Use for sliders, selections, and drag-and-drop.",
      inputSchema: z.object({
        from_x: coord("x"),
        from_y: coord("y"),
        to_x: coord("x"),
        to_y: coord("y"),
        button,
        duration_ms: z.number().int().min(50).max(5000).optional().describe("Drag duration (default 400)"),
        screenshot: screenshotFlag,
      }),
      annotations: inputAnnotations,
    },
    async ({ from_x, from_y, to_x, to_y, button, duration_ms, screenshot }) =>
      act(async () => {
        await kiwi.drag({ fromX: from_x, fromY: from_y, toX: to_x, toY: to_y, button, durationMs: duration_ms });
        return `Dragged from (${from_x}, ${from_y}) to (${to_x}, ${to_y})`;
      }, screenshot),
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description:
        'Scroll with the mouse wheel over (x, y). "down" moves further down the page. amount is wheel notches (each is a few lines). Omit x and y to scroll where the pointer is.',
      inputSchema: z.object({
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(50).optional().describe("Wheel notches (default 3)"),
        x: coord("x").optional(),
        y: coord("y").optional(),
        screenshot: screenshotFlag,
      }),
      annotations: inputAnnotations,
    },
    async ({ direction, amount, x, y, screenshot }) =>
      act(async () => {
        await kiwi.scroll({ direction, amount, x, y });
        return `Scrolled ${direction} ${amount ?? 3} notches`;
      }, screenshot),
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: `Type text into the focused field as US-layout keystrokes. "\\n" presses Enter and "\\t" presses Tab. Only printable ASCII is supported; the whole call is rejected if any character can't be typed. Max ${MAX_TEXT_LENGTH} characters.`,
      inputSchema: z.object({
        text: z.string().min(1).max(MAX_TEXT_LENGTH),
        screenshot: screenshotFlag,
      }),
      annotations: inputAnnotations,
    },
    async ({ text, screenshot }) =>
      act(async () => {
        const count = await kiwi.typeText(text);
        return `Typed ${count} characters`;
      }, screenshot),
  );

  server.registerTool(
    "press_keys",
    {
      title: "Press keys",
      description:
        'Press a key or shortcut, e.g. "enter", "escape", "tab", "cmd+space", "ctrl+alt+delete", "shift+tab", "f5", "down". Modifiers: cmd/win/meta, ctrl, alt/option, shift. Named keys: enter, escape, backspace, delete, tab, space, up, down, left, right, home, end, pageup, pagedown, f1-f24, and single characters.',
      inputSchema: z.object({
        keys: z.string().min(1).describe('Key combo joined with "+"'),
        repeat: z.number().int().min(1).max(100).optional().describe("Press the combo this many times (default 1)"),
        hold_ms: z.number().int().min(10).max(5000).optional().describe("How long to hold the keys down (default 30)"),
        screenshot: screenshotFlag,
      }),
      annotations: inputAnnotations,
    },
    async ({ keys, repeat, hold_ms, screenshot }) =>
      act(async () => {
        await kiwi.pressKeys(keys, { repeat, holdMs: hold_ms });
        return `Pressed ${keys}${repeat && repeat > 1 ? ` x${repeat}` : ""}`;
      }, screenshot),
  );

  server.registerTool(
    "release_all",
    {
      title: "Release all input",
      description: "Release every keyboard key and mouse button. Use if a key or button seems stuck on the target.",
      inputSchema: z.object({}),
      annotations: { ...inputAnnotations, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      act(async () => {
        await kiwi.releaseAll();
        return "Released all keys and buttons";
      }, false),
  );

  server.registerTool(
    "set_hid_mode",
    {
      title: "Set keyboard/mouse mode",
      description:
        'Switch the emulated keyboard and mouse between "normal" (full HID, mouse wheel works) and "legacy" (boot protocol, needed by some BIOS/UEFI setup screens and boot menus). The Kiwi normally follows the target automatically; use this only if keys do nothing in a BIOS screen ("legacy") or the wheel stops working in a running OS ("normal").',
      inputSchema: z.object({ mode: z.enum(["normal", "legacy"]) }),
      annotations: { ...inputAnnotations, destructiveHint: false, idempotentHint: true },
    },
    async ({ mode }) =>
      act(async () => {
        await kiwi.setHidMode(mode);
        return `HID mode set to ${mode}. The target may take a moment to pick up the change.`;
      }, false),
  );

  server.registerTool(
    "device_info",
    {
      title: "Kiwi device info",
      description:
        "Report the live viewer link, the Kiwi's model and firmware, serial port, capture device, and recent device log lines. Useful for troubleshooting.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guarded(async () => {
        try {
          // Some firmware never answers the info request; report everything else anyway.
          const info = await kiwi.link.requestInfo().catch((err: Error) => err);
          const videoDevice = await kiwi.video.describeDevice().catch((err: Error) => `unavailable: ${err.message}`);
          const details = {
            viewer: hooks?.viewerInfo?.()?.url,
            ...(info instanceof Error
              ? { model: `unavailable: ${info.message}` }
              : {
                  model: info.model,
                  firmware: info.firmwareVersion ? `${info.firmwareVersion} (${info.firmwareBuild})` : info.firmwareBuilds.join(", "),
                  bootloader: info.bootVersion ? `${info.bootVersion} (${info.bootBuild})` : undefined,
                }),
            serialPort: kiwi.link.path,
            videoDevice,
            screenshotSize: kiwi.screenSize,
            videoStreaming: kiwi.video.streaming,
            recentDeviceLogs: kiwi.link.recentLogs(10),
            server: `cytrence-kiwi-mcp ${VERSION}`,
          };
          return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }),
  );

  const viewerInfo = hooks?.viewerInfo?.bind(hooks);
  if (viewerInfo) {
    server.registerTool(
      "open_viewer",
      {
        title: "Open the live viewer",
        description:
          "Open the live viewer in the user's browser (on the computer running this server) so they can watch the target screen and take control. Use it when the user asks to watch or help, or has to do something on the target themselves, like typing a password. Does nothing if a viewer tab is already open.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () =>
        guarded(async () => {
          const viewer = viewerInfo();
          if (!viewer) return errorResult("The live viewer is not running.");
          if (viewer.tabs > 0) {
            const tabs = viewer.tabs === 1 ? "a browser tab" : `${viewer.tabs} browser tabs`;
            return { content: [{ type: "text", text: `The live viewer is already open in ${tabs}: ${viewer.url}` }] };
          }
          try {
            await openInBrowser(viewer.url);
          } catch (err) {
            return errorResult(`Could not open a browser (${(err as Error).message}). Give the user this link instead: ${viewer.url}`);
          }
          return {
            content: [
              {
                type: "text",
                text: `Opened the live viewer in the user's browser: ${viewer.url}. If they click, scroll, or type in it, agent input pauses until they stop.`,
              },
            ],
          };
        }),
    );
  }

  const takeOver = hooks?.takeOver?.bind(hooks);
  if (takeOver) {
    server.registerTool(
      "take_over",
      {
        title: "Take over the Kiwi",
        description:
          "Take the Kiwi from another agent session that is using it. That session's tools stop working until it takes the Kiwi back. Only call this after the user has agreed.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async () => {
        try {
          return { content: [{ type: "text", text: await takeOver() }] } satisfies ToolResult;
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );
  }

  return server;
}
