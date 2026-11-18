# cytrence-kiwi-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents see and drive a second computer
through a [Cytrence Kiwi](https://www.cytrence.com/product-page/cytrence-kiwi) USB-C KVM. The agent gets
the target's screen through the Kiwi's HDMI capture, and clicks, scrolls, and types through the Kiwi's USB
keyboard and mouse emulation.

> **Work in progress:** this is still being actively worked on. Tools, settings, and behavior may change
> between updates, so pull often and check back here when something stops working.

The target needs no software, drivers, or network access. To it, the Kiwi is just a monitor, keyboard,
and mouse. That makes this useful for BIOS screens, freshly installed machines, locked-down boxes, and
anything else you can't install an agent on.

The serial protocol isn't documented by Cytrence. It was reverse-engineered from the official app and
firmware; see [docs/PROTOCOL.md](docs/PROTOCOL.md) for the full write-up.

> **Heads-up:** anything connected to this server has full keyboard and mouse control of the target
> computer. Only point it at machines you're happy for an agent to operate.

## Requirements

- A Cytrence Kiwi, with its host USB-C port plugged into the machine running this server, and the target's HDMI and USB connected to the Kiwi.
- Node.js 20 or newer.
- ffmpeg on your `PATH` (`brew install ffmpeg`).
- The official Cytrence Kiwi app **closed** while the server is talking to the device, since both need the same serial port. The server lets go of the port after 30 s of inactivity, so you can switch back and forth.
- On macOS, Camera permission for whatever launches the server (Terminal, iTerm, Claude Desktop...): System Settings > Privacy & Security > Camera.

Tested on macOS (Apple silicon) with a Kiwi v1.1/B on firmware 2.10, driving a macOS target. The Linux
(v4l2) and Windows (dshow) capture paths are implemented but untested.

## Setup

```sh
npm install
npm run build
```

### Claude Code

```sh
claude mcp add kiwi -e KIWI_INVERT_SCROLL=1 -- node /absolute/path/to/cytrence-kiwi-mcp/dist/index.js
```

### Claude Desktop and other MCP clients

```json
{
  "mcpServers": {
    "kiwi": {
      "command": "node",
      "args": ["/absolute/path/to/cytrence-kiwi-mcp/dist/index.js"],
      "env": { "KIWI_INVERT_SCROLL": "1" }
    }
  }
}
```

`KIWI_INVERT_SCROLL=1` is for targets with natural scrolling (the macOS default). Leave it out for
Windows and most Linux targets.

## Live viewer: watch, help, take over

With the stdio setup above there is nothing to start yourself. The first time the agent uses the
Kiwi, the server starts a live viewer at `http://127.0.0.1:7523/` and the agent passes you the link
once. Open it if you want to watch or help. The viewer closes when the agent's session ends. The
agent can also open it in your browser with `open_viewer`, for example when you ask to watch or
when it needs you to type a password on the target. `device_info` reports the link too.

In the viewer, click the screen to drive the target's mouse, click again to capture your keyboard
(green border), and type and scroll as usual. Shortcuts your own computer grabs first, like cmd+tab
or ctrl+alt+delete, are in the "Send keys" menu. Pick "Custom..." there for any other combo.

"Paste" types your computer's clipboard into the target, one keystroke at a time, so it works
wherever the target's cursor is (login screens and BIOS included). The browser asks for clipboard
permission the first time; if it won't share, you get a box to paste into instead. Only US-keyboard
characters can be typed, so text with curly quotes, accents, or emoji is refused whole, and a
paste is capped at 5000 characters. Long pastes take a while, since every character is a real
keystroke; the agent stays paused until typing finishes. A newline presses Enter.

### More than one agent session

Only one process can hold the Kiwi's serial port and capture device, so only one session uses the
Kiwi at a time. Whichever session has the viewer port owns the Kiwi. Sessions that never touch the
Kiwi don't claim it, so having the server configured everywhere costs nothing.

When a second session wants the Kiwi:

- if the owner has been idle for 10 minutes (`KIWI_HANDOVER_IDLE_MS`) and nobody has its viewer
  open, the Kiwi moves over without asking.
- otherwise the second agent is told the Kiwi is busy and asks you. If you agree, it calls
  `take_over`, the first session lets go, and its tools say the Kiwi was taken until it calls
  `take_over` itself.
- an open viewer on the first session closes when it loses the Kiwi. Open the new link the agent
  gives you.

Only another Kiwi session can ask for a handover: the request is refused from a web page.

### Running it yourself (`serve`)

If you'd rather keep one server running whatever the agents do, start it on its own:

```sh
KIWI_INVERT_SCROLL=1 node dist/index.js serve        # or: npm run serve
```

That starts one long-running process on `http://127.0.0.1:7523` with the viewer at `/` and a
streamable HTTP MCP endpoint at `/mcp`. Point the agent at it instead of launching its own:

```sh
claude mcp add --transport http kiwi http://127.0.0.1:7523/mcp
```

A stdio session never takes the Kiwi from `serve`. It tells the agent to connect to `/mcp` or ask
you to stop that server. `serve` has to outlive the agent's command, so start it in a terminal you
own or as a login item.

### Sharing control

You and the agent share the machine. When you click, scroll, or type in the viewer the agent is
paused ("Take over when I use it", on by default), and its input tools return an error telling it
to wait. Once you've sent no input for 15 seconds (`KIWI_AUTO_RESUME_MS`) the agent gets control
back on its own, and the status pill counts down to it. Any input you send, mouse moves included,
resets that countdown. Press "Resume agent" to hand control back sooner. Just moving the mouse over
the viewer does not pause it. A pause from the "Pause agent" button lasts until you press Resume.
The Activity panel (the icon at the top right) lists every agent action as it happens. It starts
hidden to give the screen more room, and the viewer remembers whether you left it open.

If the target's screen isn't 16:9 (most Macs are 16:10), the Kiwi sends its picture centred
between black bars. The server finds those bars and maps clicks to the picture inside them, so
the cursor lands where you or the agent pointed. Clicks on a bar go to the nearest edge of the
screen.

The server only listens on localhost and rejects requests addressed to other hostnames, and only
the viewer page itself can send input. Anything running on your Mac can still reach it, so don't
expose the port to a network.

## Tools

| Tool | What it does |
| --- | --- |
| `screenshot` | Capture the target screen as a JPEG (1280x720 by default). All coordinates refer to this image. |
| `click` | Click at (x, y); supports right/middle buttons, double and triple clicks, and held modifiers (e.g. `cmd`). |
| `mouse_move` | Move the pointer without clicking (hover). |
| `drag` | Press, move smoothly, release. For selections, sliders, and drag-and-drop. |
| `scroll` | Wheel scroll up/down/left/right over a point. |
| `type_text` | Type text with US-layout keystrokes. `\n` presses Enter and `\t` presses Tab. |
| `press_keys` | Press a key or shortcut: `enter`, `cmd+space`, `ctrl+alt+delete`, `shift+tab`, `f5`... |
| `release_all` | Release every key and button (if something seems stuck). |
| `set_hid_mode` | Switch between normal HID and legacy boot-protocol HID (some BIOS screens need legacy). |
| `device_info` | Live viewer link, Kiwi model, firmware and bootloader versions, ports in use, and recent device log lines. |
| `open_viewer` | Open the live viewer in your browser, unless a viewer tab is already open. |
| `take_over` | Take the Kiwi from another agent session (stdio only, after you agree). |

Every input tool takes an optional `screenshot: true`. It returns a fresh capture once the UI has
settled, which saves the agent a round trip.

## Configuration

All settings are optional environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIWI_SERIAL_PORT` | auto | Serial device. Auto-detects the Kiwi's CH340 (USB `1a86:7523`). |
| `KIWI_BAUD` | `2000000` | Serial baud rate. |
| `KIWI_SERIAL_IDLE_MS` | `30000` | Release the serial port after this much idle time. `0` keeps it open. |
| `KIWI_VIDEO_DEVICE` | auto | Capture device name (macOS/Windows) or `/dev/videoN` (Linux). |
| `KIWI_CAPTURE_SIZE` | `1920x1080` | Capture mode requested from the Kiwi. |
| `KIWI_SCREENSHOT_WIDTH` | `1280` | Width of screenshots sent to the agent (height keeps the aspect ratio). |
| `KIWI_VIDEO_IDLE_MS` | `60000` | Stop the background ffmpeg stream after this much idle time. `0` runs ffmpeg once per screenshot. The stream stays up while a viewer is open. |
| `KIWI_VIDEO_FPS` | `10` (`20` under `serve`) | Frames per second of the background stream. |
| `KIWI_PORT` | `7523` | Viewer port (same as `--port`). Stdio sessions also use it to tell which one has the Kiwi, so give every session the same port. |
| `KIWI_INVERT_SCROLL` | off | Flip scroll direction, for targets with natural scrolling. |
| `KIWI_KEY_DELAY_MS` | `12` | Delay between keyboard reports while typing. |
| `KIWI_SETTLE_MS` | `500` | Wait before the screenshot that follows an action. |
| `KIWI_AUTO_RESUME_MS` | `15000` | After you take over in the viewer, give control back to the agent once you've sent no input for this long. `0` keeps it paused until you press Resume. |
| `KIWI_HANDOVER_IDLE_MS` | `600000` | A session that hasn't used the Kiwi for this long, with no viewer open, hands it to another session without asking. |
| `KIWI_DETECT_BARS` | on | Find black bars around the target's picture and map the mouse inside them. Set to `0` if the target's own screen has black edges that get mistaken for bars. |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary. |

## Manual testing CLI

The same code paths are available from the shell, which is handy for checking the hardware without an agent:

```sh
npm run cli -- info
npm run cli -- screenshot shot.jpg
npm run cli -- click 640 360
npm run cli -- scroll down 5 640 360
npm run cli -- key cmd+space
npm run cli -- type "hello world"
npm run cli -- hid-mode normal
```

After `npm run build` it's also available as `node dist/cli.js ...`.

## Development

```sh
npm test          # protocol unit tests, anchored on frames captured from real hardware
npm run typecheck
npm run dev       # run the MCP server from source with tsx
```

Source layout:

- `src/protocol.ts`: frame encoding and decoding, CRC-8, HID report builders.
- `src/link.ts`: serial connection (auto-detect, warm-up, write serialization, idle close).
- `src/video.ts`: ffmpeg capture, with a warm MJPEG stream and a one-shot fallback.
- `src/keys.ts`: key names, chords, and the US-layout text map.
- `src/kiwi.ts`: high-level gestures (click, drag, scroll, typing).
- `src/index.ts`: the MCP server.
- `src/cli.ts`: the manual test CLI.

## Troubleshooting

**"Serial port ... is in use"**

Quit the Cytrence Kiwi app.

**"No Cytrence Kiwi serial port found"**

The Kiwi's host-side USB-C cable isn't connected to this computer, or `KIWI_SERIAL_PORT` points somewhere else.

**Screenshots fail on macOS**

Grant Camera permission to the app that launches the server, then restart that app.

**Scrolling goes the wrong way**

Toggle `KIWI_INVERT_SCROLL`.

**Keys do nothing in a BIOS or boot menu**

Call `set_hid_mode` with `legacy`. Switch back to `normal` once the OS has loaded.

**Wrong characters when typing**

`type_text` assumes the target uses a US keyboard layout.

## Disclaimer

This is an independent project, not affiliated with or endorsed by Cytrence. It relies on an undocumented
protocol, so a firmware update could break it.

## License

MIT
