// Line text as diffcity shows it, shared by the file view (file-diff.ts) and
// the step excerpts (path/diff.ts): no trailing CR, at most MAX_ROW_TEXT
// characters, never a split surrogate pair.

/** Longest row text, in characters. */
export const MAX_ROW_TEXT = 4000;

/** `text` without a trailing CR, cut to MAX_ROW_TEXT characters; `cut` tells whether anything was dropped. */
export function rowText(text: string): { text: string; cut: boolean } {
  const line = text.endsWith('\r') ? text.slice(0, -1) : text;
  if (line.length <= MAX_ROW_TEXT) return { text: line, cut: false };
  let end = MAX_ROW_TEXT;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: line.slice(0, end), cut: true };
}
