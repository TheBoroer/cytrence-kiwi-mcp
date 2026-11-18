# Cytrence Kiwi: serial protocol

Everything here was worked out from the official macOS app (`Cytrence Kiwi.app` v1.6.4, arm64 slice)
and the firmware images it embeds, then confirmed against real hardware: a Kiwi v1.1/B with firmware 2.10
(build 2026.07.17T17:56:20Z) and bootloader 2.8 (build 2026.03.02T23:06:34Z), driving a macOS target.

Nothing in here is official. Cytrence may change any of it in a firmware update.

## Chipset

```
host USB-C ── internal hub ─┬─ MS2130 (likely): UVC video, UAC audio, vendor HID for video settings
                            └─ WCH CH340 USB-serial ──UART 2 Mbaud, RTS/CTS──> RP2040 ──USB device──> target
```

| Chip | Role | How we know |
| --- | --- | --- |
| **Raspberry Pi RP2040** | Main MCU. Runs Cytrence's firmware and is the USB device the target sees (keyboard, mice, and optionally mass storage and CDC serial). | Confirmed from the firmware image: it carries the RP2040 `boot2_w25q080` second-stage flash bootloader, the vector table sets the initial stack to `0x20042000` (the top of RP2040's 264 KB SRAM), code runs from XIP flash at `0x1000xxxx`, and the USB stack is TinyUSB. |
| **WCH CH340** | USB-to-UART bridge between the host and the RP2040. It only carries bytes; all the logic is in the RP2040. | Confirmed: USB ID `1a86:7523`, and it's the port the app opens. |
| **MacroSilicon MS2130** | HDMI capture (USB 3, uncompressed 1080p60) and HDMI audio. | Likely, not physically verified: the capture device's USB ID `345f:2130` is the MS2130's default, and its extra vendor HID interface matches how MacroSilicon chips expose register access. |

The app tracks the capture chip's firmware separately (`CycVersion::AvFirmwareVersion`), which fits a
separate video chip next to the RP2040.

## Hardware overview

The Kiwi sits between two computers:

- **Host** (the machine running this MCP server) connects to the Kiwi's host USB-C port.
- **Target** (the machine being controlled) gets HDMI out into the Kiwi and a USB cable from the Kiwi.

On the host, the Kiwi shows up as a USB hub with two devices behind it:

**Composite device `36572133 Kiwi (<serial>)`** (VID `0x345f`, PID `0x2130`)

| Interface | What it is | Used here for |
| --- | --- | --- |
| UVC camera, listed as `Cytrence Kiwi (<serial>)` | HDMI capture, up to 1920x1080 | Screenshots |
| UAC audio | HDMI audio | Not used |
| Vendor HID | Video-chip control via feature reports | Not used |

**`USB Serial`, a WCH CH340** (VID `0x1a86`, PID `0x7523`)

| What it is | Used here for |
| --- | --- |
| Control channel to the Kiwi's MCU | Keyboard and mouse injection, device info |

The MCU is a Raspberry Pi RP2040 (the firmware carries the `boot2_w25q080` second-stage bootloader) running a
TinyUSB-based firmware. On the target side it presents a composite USB HID device (keyboard, relative mouse,
absolute mouse) and, optionally, mass storage and CDC.

On the target, the RP2040 enumerates as `Kiwi` (VID `0x39c9`, PID `0x400c`), and its USB serial number is
the flash chip's unique ID, so it's unique per unit. Leave it out of logs and issues you share. With the
Standard firmware it exposes only HID interfaces.

Important detail from the early investigation: the control channel is **not** a CH9329 (the common
USB-serial-to-HID chip used by many cheap KVMs). It's a custom framed protocol to the RP2040, described below.

## Serial link

| Setting | Value |
| --- | --- |
| Device | `/dev/cu.usbserial-*` on macOS (use the `cu.` callout node, not `tty.`) |
| Baud | 2,000,000 (the app also offers 921,600 and 1,500,000) |
| Format | 8N1 |
| Flow control | RTS/CTS hardware flow control (`comm.hardwareFlowControl: true` in the app config) |

macOS needs the `IOSSIOSPEED` ioctl (`0x80085402`) for non-standard rates. `node-serialport` already does
this when the rate is not a `Bxxx` constant.

The official app takes an exclusive `flock` on the port, so only one program can talk to the Kiwi at a
time. This server closes the port after `KIWI_SERIAL_IDLE_MS` (30 s by default) so the two can take turns.

The first frame after opening the port is sometimes ignored. The server sends a harmless info request as a
warm-up before any input.

## Frame format ("CyMsg")

All integers are little-endian.

```
offset  size  field
0       4     preamble       3c 5a a5 c3
4       1     flags          0 for input frames; the app uses 2 for KiwiInfo (0x64) and KiwiConfig (0x78)
5       1     crc            CRC-8 of the body only
6       2     seq            incrementing sequence number (the device accepts any value, including 0)
8       2     type           message type, see below
10      2     length         body length in bytes
12      n     body
12+n    4     trailer        c9 6d d6 9c
```

**CRC:** CRC-8, polynomial `0x07`, init `0x00`, no reflection, no final XOR, over the body bytes only. The
app uses a 256-entry lookup table (`CyUtils::CRC8_table`). A frame the Kiwi actually sent back:

```
3c5aa5c3 00 2b 2500 2c01 2100 | 0200 "Msg: To respond with kiwi info\0" | c96dd69c
         fl crc seq  type len  | body (33 bytes)                         | trailer
```

### Example: Cmd+Space

```
3c5aa5c3 00 48 6600 9001 0800 | 08 00 2c 00 00 00 00 00 | c96dd69c
```

Type `0x190` (keyboard), body = HID boot keyboard report with Left GUI (`0x08`) and Space (`0x2c`).

## Message types

### Host to Kiwi

| Type | Name | Body | Notes |
| --- | --- | --- | --- |
| `0x0032` (50) | Hello | 4 bytes | The app sends it right after opening the port. Not needed for input. |
| `0x0078` (120) | KiwiConfig | 20 bytes | Overwrites the device config **and saves it to flash**. Not used here (see below). |
| `0x0096` (150) | TargetConfig | `[deviceType, enable]` | Turns target-side USB functions on or off (`0` = USB HID, `1` = mass storage). Not used here. |
| `0x00C8` (200) | Info request | `01 00` | Answered with a `0x12C` log line and a `0x64` KiwiInfo frame. |
| `0x0190` (400) | Keyboard | 8 bytes | Standard HID boot keyboard report: `modifiers, 0, key1..key6`. |
| `0x019A` (410) | Relative mouse | 5 bytes | `u8 buttons, i8 dx, i8 dy, i8 wheel, i8 pan` |
| `0x019B` (411) | Absolute mouse | 7 bytes | `u8 buttons, u16 x, u16 y, i8 wheel, i8 pan`; x and y are 0..32767 across the whole screen |
| `0x01A4` (420) | (unknown) | ? | Handled by the firmware next to the keyboard queue; the app sends it from a background thread (likely text paste/macros). Not used. |
| `0x01AE` (430) | HID boot mode | `[mode]` | `1` = legacy/boot-protocol HID, `0` = normal. This is the app's "Change to legacy keyboard temporarily" / "Change to normal keyboard" button. |
| `0x0BC2` (3010) | Reboot to bootloader | empty | Reboots the MCU into its USB bootloader. **Never sent by this server** (see "Messages this server never sends"). |

Mouse buttons: bit 0 left, bit 1 right, bit 2 middle, bit 3 back, bit 4 forward.

Keyboard modifiers: bit 0 LCtrl, 1 LShift, 2 LAlt, 3 LGUI (Cmd/Win), 4 RCtrl, 5 RShift, 6 RAlt, 7 RGUI.
Key codes are USB HID usage page 0x07 codes. They're physical key positions, so the target's keyboard
layout decides which character appears. This server assumes US layout for `type_text`.

The app's own mouse path (`CycHidCapture::Mouse::SendEvent`) always sends relative reports, and puts SDL
wheel deltas in the wheel/pan bytes. Absolute reports (`OnAbsMotion`) are used in its "desktop integration"
mode. This server uses absolute reports for everything, so a click always lands exactly where the
screenshot says, with no pointer acceleration involved.

### Kiwi to host

| Type | Name | Body |
| --- | --- | --- |
| `0x0064` (100) | KiwiInfo | 132 bytes, layout below |
| `0x012C` (300) | Log message | `u16 level`, then a NUL-terminated string |
| ? | KiwiState | Periodic status (temperature, IO state, "shared usb/sd"). The app logs it as `KiwiState: states %08X, temperature %hhuC, ...`. It never arrived without the app's handshake, so its type is unknown. |

KiwiInfo layout (firmware 2.10):

```
0x00  01 00 04 00 ...          header fields, not decoded
0x0C  "Kiwi (v1.1/B)\0"        model
0x4C  u16 2, u16 8             bootloader version 2.8
0x50  "2026.03.02T23:06:34Z\0" bootloader build
0x65  u16 2, u16 10            firmware version 2.10
0x69  "2026.07.17T17:56:20Z\0" firmware build
0x7E  01 00 ...                sku 1, gpios, features
```

The app logs the same fields as `sku 1, firmware 2.10, 2026.07.17T17:56:20Z  boot 2.8, 2026.03.02T23:06:34Z  gpios 0 features 0x0`.

## Device behavior

### Messages this server never sends

Some message types change persistent state or take the Kiwi offline. The server never sends them, and new
tools shouldn't either:

- `0x0078` (120) KiwiConfig: overwrites the saved device config (see below).
- `0x0096` (150) TargetConfig: switches target-side USB functions.
- `0x0BC2` (3010): reboots the MCU into its USB bootloader. The Kiwi stops responding until it's power-cycled.
- 3000 and 4110 to 4150: the official app's reboot and firmware-update sequence.

On the Standard model the firmware doesn't appear to handle TargetConfig (150) or the terminal (511),
GPIO (551) and disk control (610) messages.

### Target-side HID descriptors

Taken from the firmware image:

**Composite keyboard + mouse**

- Report ID 1: boot-compatible keyboard.
- Report ID 2: mouse with 5 buttons, X/Y as `i8` relative, a wheel (usage `0x38`, `i8`), and AC Pan (consumer usage `0x238`, `i8`).

That's the stock TinyUSB `TUD_HID_REPORT_DESC_MOUSE`.

**Absolute mouse** (no report ID)

- 5 buttons.
- X/Y as `u16` absolute, logical range 0..32767.
- Wheel and AC Pan as `i8`.

**Standalone boot keyboard** (no report ID)

Used in boot mode.

### HID boot mode

The firmware keeps a "boot mode" flag:

- The target's `SET_PROTOCOL(boot)` request sets it ("Enter HID boot mode").
- `SET_PROTOCOL(report)` clears it ("Leave HID boot mode") unless config byte `0x13` forces boot mode ("Ingore HID reporting mode switch, forced in boot mode").
- USB unmount and suspend also clear it.
- Message `0x1AE` sets it directly.

In boot mode the firmware sends keyboard reports with report ID 0 for BIOS compatibility.

### KiwiConfig (0x78)

The 0x78 handler copies the 20-byte body straight into the device config and saves it to flash. Known
bytes:

- **Byte 4:** log every keyboard report.
- **Byte 5:** log every mouse report (`Mouse: interface %hhu, report id %hhu, buttons ..., wheel ...`).
- **Byte `0x13`:** force HID boot mode.

Because it's a full overwrite of persistent config, this server never sends it.

## Video capture

The capture side is a standard UVC device, so any capture API works. On macOS, AVFoundation lists it as
`Cytrence Kiwi (<serial>)` and ffmpeg can read it:

```sh
ffmpeg -f avfoundation -video_size 1920x1080 -framerate 30 -pixel_format nv12 \
  -i "Cytrence Kiwi (9915FA6119):none" -frames:v 1 frame.jpg
```

Opening the device costs about 1.3 s, so the server keeps one ffmpeg process streaming MJPEG at 10 fps
while it's in use. A warm screenshot then takes about 100 ms. The stream stops after `KIWI_VIDEO_IDLE_MS`
of inactivity.

## Gotchas we hit

- **The Cytrence app must be closed.** It holds an exclusive lock on the serial port, and while it was open our frames went nowhere.
- **CH9329 probes get no answer.** The obvious guess (a CH9329 bridge) was wrong, and the port stayed silent until we used the CyMsg framing.
- **Scrolling seemed broken for a while, but wasn't.** The target Mac has natural scrolling on, which flips the wheel. Every test started at the top of a page, so "down" pushed against the top and nothing visibly moved. Set `KIWI_INVERT_SCROLL=1` for macOS targets with natural scrolling.
- **Input sent right after a `0x1AE` mode switch can be dropped** for about a second while the target catches up.
- **The model string is at a fixed offset.** Scanning the KiwiInfo body for printable runs picks up a stray `7` (`0x37` at offset `0x0B`), so read the model at `0x0C`.
