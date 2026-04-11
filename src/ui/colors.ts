const ESC = "\x1b[";
const RESET = "\x1b[0m";

// Disable colors when not a TTY or when NO_COLOR is set
const NO_COLOR =
  !process.stdout.isTTY ||
  process.env.NO_COLOR !== undefined ||
  process.env.TERM === "dumb";

function wrap(code: string, text: string): string {
  if (NO_COLOR) return text;
  return `${ESC}${code}m${text}${RESET}`;
}

export const clr = {
  // styles
  bold: (t: string) => wrap("1", t),
  dim: (t: string) => wrap("2", t),
  italic: (t: string) => wrap("3", t),
  underline: (t: string) => wrap("4", t),

  // standard colors
  black: (t: string) => wrap("30", t),
  red: (t: string) => wrap("31", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  blue: (t: string) => wrap("34", t),
  magenta: (t: string) => wrap("35", t),
  cyan: (t: string) => wrap("36", t),
  white: (t: string) => wrap("37", t),

  // bright variants
  brightRed: (t: string) => wrap("91", t),
  brightGreen: (t: string) => wrap("92", t),
  brightYellow: (t: string) => wrap("93", t),
  brightBlue: (t: string) => wrap("94", t),
  brightMagenta: (t: string) => wrap("95", t),
  brightCyan: (t: string) => wrap("96", t),
  brightWhite: (t: string) => wrap("97", t),

  // semantic aliases
  success: (t: string) => wrap("32", t),
  error: (t: string) => wrap("91", t),
  warn: (t: string) => wrap("93", t),
  info: (t: string) => wrap("36", t),
  muted: (t: string) => wrap("2", t),
  highlight: (t: string) => wrap("96", t),
  accent: (t: string) => wrap("35", t),
};

// Strip ANSI codes (for length calculations)
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function isColorEnabled(): boolean {
  return !NO_COLOR;
}
