/**
 * USB HID keyboard usage codes (HID Usage Tables, page 0x07) and helpers to turn
 * key names, combos like "cmd+shift+4", and plain text into boot keyboard reports.
 *
 * Text typing assumes the target uses a US keyboard layout: the Kiwi sends
 * physical key positions, and the target OS maps them to characters.
 */

export const Modifier = {
  LeftCtrl: 0x01,
  LeftShift: 0x02,
  LeftAlt: 0x04,
  LeftGui: 0x08,
  RightCtrl: 0x10,
  RightShift: 0x20,
  RightAlt: 0x40,
  RightGui: 0x80,
} as const;

const MODIFIER_ALIASES: Record<string, number> = {
  ctrl: Modifier.LeftCtrl,
  control: Modifier.LeftCtrl,
  lctrl: Modifier.LeftCtrl,
  rctrl: Modifier.RightCtrl,
  shift: Modifier.LeftShift,
  lshift: Modifier.LeftShift,
  rshift: Modifier.RightShift,
  alt: Modifier.LeftAlt,
  option: Modifier.LeftAlt,
  opt: Modifier.LeftAlt,
  lalt: Modifier.LeftAlt,
  ralt: Modifier.RightAlt,
  altgr: Modifier.RightAlt,
  cmd: Modifier.LeftGui,
  command: Modifier.LeftGui,
  meta: Modifier.LeftGui,
  super: Modifier.LeftGui,
  win: Modifier.LeftGui,
  windows: Modifier.LeftGui,
  gui: Modifier.LeftGui,
  lcmd: Modifier.LeftGui,
  rcmd: Modifier.RightGui,
};

const KEY_CODES: Record<string, number> = {
  enter: 0x28,
  return: 0x28,
  escape: 0x29,
  esc: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  minus: 0x2d,
  equal: 0x2e,
  equals: 0x2e,
  leftbracket: 0x2f,
  rightbracket: 0x30,
  backslash: 0x31,
  semicolon: 0x33,
  quote: 0x34,
  apostrophe: 0x34,
  grave: 0x35,
  backtick: 0x35,
  comma: 0x36,
  period: 0x37,
  dot: 0x37,
  slash: 0x38,
  capslock: 0x39,
  printscreen: 0x46,
  scrolllock: 0x47,
  pause: 0x48,
  insert: 0x49,
  home: 0x4a,
  pageup: 0x4b,
  delete: 0x4c,
  del: 0x4c,
  forwarddelete: 0x4c,
  end: 0x4d,
  pagedown: 0x4e,
  right: 0x4f,
  arrowright: 0x4f,
  left: 0x50,
  arrowleft: 0x50,
  down: 0x51,
  arrowdown: 0x51,
  up: 0x52,
  arrowup: 0x52,
  numlock: 0x53,
  menu: 0x65,
  application: 0x65,
};

for (let i = 0; i < 26; i++) KEY_CODES[String.fromCharCode(97 + i)] = 0x04 + i;
for (let i = 1; i <= 9; i++) KEY_CODES[String(i)] = 0x1e + (i - 1);
KEY_CODES["0"] = 0x27;
for (let i = 1; i <= 12; i++) KEY_CODES[`f${i}`] = 0x3a + (i - 1);
for (let i = 13; i <= 24; i++) KEY_CODES[`f${i}`] = 0x68 + (i - 13);

/** US layout: character -> [usage code, needs shift]. */
const CHAR_MAP = new Map<string, [number, boolean]>();
for (let i = 0; i < 26; i++) {
  CHAR_MAP.set(String.fromCharCode(97 + i), [0x04 + i, false]);
  CHAR_MAP.set(String.fromCharCode(65 + i), [0x04 + i, true]);
}
"1234567890".split("").forEach((c, i) => CHAR_MAP.set(c, [0x1e + i, false]));
"!@#$%^&*()".split("").forEach((c, i) => CHAR_MAP.set(c, [0x1e + i, true]));
const PUNCTUATION: Array<[string, string, number]> = [
  ["-", "_", 0x2d],
  ["=", "+", 0x2e],
  ["[", "{", 0x2f],
  ["]", "}", 0x30],
  ["\\", "|", 0x31],
  [";", ":", 0x33],
  ["'", '"', 0x34],
  ["`", "~", 0x35],
  [",", "<", 0x36],
  [".", ">", 0x37],
  ["/", "?", 0x38],
];
for (const [plain, shifted, code] of PUNCTUATION) {
  CHAR_MAP.set(plain, [code, false]);
  CHAR_MAP.set(shifted, [code, true]);
}
CHAR_MAP.set(" ", [0x2c, false]);
CHAR_MAP.set("\n", [0x28, false]);
CHAR_MAP.set("\t", [0x2b, false]);

export interface KeyChord {
  modifiers: number;
  keys: number[];
}

export const KEY_NAMES = Object.freeze(Object.keys(KEY_CODES).sort());
export const MODIFIER_NAMES = Object.freeze(Object.keys(MODIFIER_ALIASES).sort());

/**
 * Parses a chord such as "cmd+space", "ctrl+shift+t", "f5", "a", or "shift" into
 * a modifier mask plus up to six key codes. Single punctuation characters
 * ("+" excluded, use "shift+equal") are also accepted.
 */
export function parseChord(chord: string): KeyChord {
  const trimmed = chord.trim();
  if (!trimmed) throw new Error("Empty key combo");

  let modifiers = 0;
  const keys: number[] = [];
  for (const rawPart of trimmed.split("+")) {
    const part = rawPart.trim();
    if (!part) throw new Error(`Invalid key combo "${chord}" (use "shift+equal" for a plus sign)`);
    const name = part.toLowerCase().replace(/[\s_-]/g, "");

    const modifier = MODIFIER_ALIASES[name];
    if (modifier !== undefined) {
      modifiers |= modifier;
      continue;
    }

    const code = KEY_CODES[name] ?? (part.length === 1 ? CHAR_MAP.get(part.toLowerCase())?.[0] : undefined);
    if (code === undefined) throw new Error(`Unknown key "${part}" in "${chord}"`);
    if (!keys.includes(code)) keys.push(code);
  }

  if (keys.length > 6) throw new Error(`Too many keys in "${chord}" (HID boot reports hold at most 6)`);
  return { modifiers, keys };
}

export interface TypedChar {
  char: string;
  modifiers: number;
  key: number;
}

/** Maps text to US-layout keystrokes. Characters without a mapping are returned separately. */
export function textToKeystrokes(text: string): { strokes: TypedChar[]; unsupported: string[] } {
  const strokes: TypedChar[] = [];
  const unsupported = new Set<string>();
  for (const char of text.replace(/\r\n?/g, "\n")) {
    const mapped = CHAR_MAP.get(char);
    if (!mapped) {
      unsupported.add(char);
      continue;
    }
    const [key, shift] = mapped;
    strokes.push({ char, key, modifiers: shift ? Modifier.LeftShift : 0 });
  }
  return { strokes, unsupported: [...unsupported] };
}

/** Browser `KeyboardEvent.code` (physical key) to modifier bit, for the live viewer. */
const MODIFIER_BY_CODE: Record<string, number> = {
  ControlLeft: Modifier.LeftCtrl,
  ShiftLeft: Modifier.LeftShift,
  AltLeft: Modifier.LeftAlt,
  MetaLeft: Modifier.LeftGui,
  OSLeft: Modifier.LeftGui,
  ControlRight: Modifier.RightCtrl,
  ShiftRight: Modifier.RightShift,
  AltRight: Modifier.RightAlt,
  MetaRight: Modifier.RightGui,
  OSRight: Modifier.RightGui,
};

/** Browser `KeyboardEvent.code` (physical key) to HID usage code, for the live viewer. */
const USAGE_BY_CODE: Record<string, number> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  PrintScreen: 0x46,
  ScrollLock: 0x47,
  Pause: 0x48,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  NumLock: 0x53,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  NumpadDecimal: 0x63,
  IntlBackslash: 0x64,
  ContextMenu: 0x65,
  NumpadEqual: 0x67,
};
for (let i = 0; i < 26; i++) USAGE_BY_CODE[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) USAGE_BY_CODE[`Digit${i}`] = 0x1e + (i - 1);
USAGE_BY_CODE.Digit0 = 0x27;
for (let i = 1; i <= 9; i++) USAGE_BY_CODE[`Numpad${i}`] = 0x59 + (i - 1);
USAGE_BY_CODE.Numpad0 = 0x62;
for (let i = 1; i <= 12; i++) USAGE_BY_CODE[`F${i}`] = 0x3a + (i - 1);
for (let i = 13; i <= 24; i++) USAGE_BY_CODE[`F${i}`] = 0x68 + (i - 13);

/**
 * Turns the set of physical keys currently held in the browser (`KeyboardEvent.code`
 * values) into one keyboard report's worth of state. Unknown codes are ignored and
 * anything past six non-modifier keys is dropped, as a boot keyboard would.
 */
export function chordFromCodes(codes: readonly string[]): KeyChord {
  let modifiers = 0;
  const keys: number[] = [];
  for (const code of codes) {
    const modifier = MODIFIER_BY_CODE[code];
    if (modifier !== undefined) {
      modifiers |= modifier;
      continue;
    }
    const usage = USAGE_BY_CODE[code];
    if (usage !== undefined && !keys.includes(usage) && keys.length < 6) keys.push(usage);
  }
  return { modifiers, keys };
}
