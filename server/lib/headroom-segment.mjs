// SPDX-License-Identifier: Apache-2.0
//
// Translated from Headroom's prompt-conditioned relevance split, copyright
// Headroom Labs and the Headroom contributors, Apache-2.0:
//
//   https://github.com/headroomlabs-ai/headroom
//   commit 976aa714ef3e19174dc0cb586cee7b20d064e4ef
//   headroom/transforms/relevance_split.py                          segment
//   crates/headroom-core/src/transforms/text_crusher/crusher.rs     shingles
//
// Changed in translation: lines end at "\n" only, and MAX_CHARS counts UTF-16
// code units where the original counts code points.

// Partition CONTENT into coherent records; joining them gives CONTENT back.
// A blank line ends a record.  A block without blank lines is cut into
// windows of at most WINDOW lines and MAX_CHARS characters, and an indented
// continuation line stays with the window it continues while the character
// budget allows, so a stack trace or a nested list item is not cut mid-unit.
// A single line longer than MAX_CHARS is one record.
export function segment(content, { window = 8, maxChars = 1200 } = {}) {
  const lines = String(content).match(/[^\n]*\n|[^\n]+$/g) || [];
  if (lines.length <= 1) return content ? [content] : [];
  const blocks = [];
  let current = [];
  for (const line of lines) {
    current.push(line);
    if (line.trim() === "") {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  const segments = [];
  for (const block of blocks) {
    for (let start = 0; start < block.length;) {
      let end = start + 1;
      let size = block[start].length;
      while (end < block.length
             && (end - start < window || block[end][0] === " " || block[end][0] === "\t")
             && size + block[end].length <= maxChars) {
        size += block[end].length;
        end += 1;
      }
      segments.push(block.slice(start, end).join(""));
      start = end;
    }
  }
  return segments;
}

// The K-word windows of WORDS, for telling that one passage repeats another.
// A passage shorter than K words gives every window it has, so two identical
// short passages still match each other.
export function shingles(words, k = 3) {
  const set = new Set();
  if (words.length < k) {
    for (let size = 1; size <= words.length; size++) {
      for (let start = 0; start + size <= words.length; start++) set.add(words.slice(start, start + size).join("\u0001"));
    }
    return set;
  }
  for (let start = 0; start + k <= words.length; start++) set.add(words.slice(start, start + k).join("\u0001"));
  return set;
}
