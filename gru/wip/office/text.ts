// Terminal-safe text for the office: sanitising and display width.
//
// Almost every string the office shows came out of the ledger, and most of
// those were written by a model (claims, tool names, paths) or read from
// the workspace. That text is T3/T4 data. clean() removes control
// characters (so an ESC in a claim cannot repaint the screen or forge a
// stamp), format characters (bidi overrides, zero-width joiners) and
// variation selectors before anything is stored or drawn.
//
// displayWidth() decides how many terminal columns a string takes, so a
// frame can promise never to exceed its width. It errs wide: East Asian
// wide and fullwidth characters and anything emoji-like count as 2,
// everything else that survives clean() as 1. Over-counting only leaves a
// line a little short; under-counting would wrap it.
//
// Limits, stated rather than implied: East Asian *ambiguous* characters
// (including the box-drawing and block glyphs the office draws with) are
// counted as 1 column, which is what terminals do outside CJK locales; a
// terminal configured to render them wide will draw the floor wider than
// the frame's width. Look-alike (homoglyph) characters pass through.

/** Ranges rendered two columns wide (East Asian Wide/Fullwidth, plus emoji blocks). */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
];

// Emoji-like characters, and private-use glyphs (icon fonts draw some wide).
const COUNTED_WIDE = /[\p{Extended_Pictographic}\p{Co}]/u;

export function charWidth(char: string): 1 | 2 {
  const code = char.codePointAt(0) ?? 0;
  for (const [low, high] of WIDE) {
    if (code >= low && code <= high) return 2;
  }
  return COUNTED_WIDE.test(char) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

// C0, DEL and C1 controls; format characters (bidi marks, embeddings,
// overrides and isolates, zero-width space/joiners, soft hyphen, tags);
// line and paragraph separators; variation selectors; lone surrogates.
const CONTROL = /[\u0000-\u001f\u007f-\u009f  ]/gu;
const INVISIBLE = /[\p{Cf}︀-️\u{E0100}-\u{E01EF}]|\p{Cs}/gu;

/**
 * One line of display-safe text: controls become spaces, invisible
 * characters are removed, whitespace runs collapse, and the result is
 * capped at `max` characters with "..." marking the cut.
 */
export function clean(value: string, max = 240): string {
  const text = value
    .normalize("NFC")
    .replace(CONTROL, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 3)).join("")}...`;
}

/** Truncate to at most `width` columns, marking a cut with `mark`. */
export function fit(text: string, width: number, mark = "..."): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const markWidth = displayWidth(mark);
  const room = width - markWidth;
  if (room <= 0) return [...text].reduce((out, char) => (displayWidth(out + char) <= width ? out + char : out), "");
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = charWidth(char);
    if (used + w > room) break;
    out += char;
    used += w;
  }
  return out + mark;
}

/** The first candidate that fits whole, else the last one truncated. */
export function fitFirst(candidates: readonly string[], width: number): string {
  for (const candidate of candidates) {
    if (displayWidth(candidate) <= width) return candidate;
  }
  return fit(candidates.at(-1) ?? "", width);
}

/** Word-wrap into at most `maxLines` lines of `width` columns; the last line is truncated if needed. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return [];
  const lines: string[] = [];
  let current = "";
  const words = text.split(" ").filter((word) => word.length > 0);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = "";
    }
    if (lines.length === maxLines - 1) {
      current = words.slice(index).join(" ");
      break;
    }
    if (displayWidth(word) > width) {
      // A word longer than the line is cut rather than overflowing.
      lines.push(fit(word, width));
      if (lines.length === maxLines) return lines;
    } else {
      current = word;
    }
  }
  if (current.length > 0) lines.push(fit(current, width));
  return lines.slice(0, maxLines);
}
