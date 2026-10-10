// SPDX-License-Identifier: GPL-3.0-or-later
//
// Translated from nanoMuse's memory store, copyright the nanoMuse
// contributors, GPL-3.0-or-later:
//
//   https://github.com/nano-muse/nanoMuse
//   commit 1e08351843052ddcace724e8cac1e4aefbc1101c
//   nanomuse/memory/store.py        tokenize, similarity, MemoryStore.search
//   nanomuse/memory/embeddings.py   fuse, standouts
//   nanomuse/memory/consolidate.py  _same_stem
//
// The functions keep upstream's behaviour line for line; only the item shape
// changed (plain objects instead of MemoryItem).  Noema's own tokenizer, with
// its wider CJK range, lives in text-similarity.mjs.

// A word is a run of letters or digits in any script; CJK is left out of the
// class and handled by character below.
const WORD_RE = /(?:(?![㐀-鿿_])[\p{L}\p{N}])+/gu;
const CJK_RE = /[㐀-鿿]/gu;
export const RRF_K = 60;

// Words for alphabetic scripts (case folded) + character bigrams for CJK.
export function tokenize(text) {
  const value = String(text ?? "");
  const tokens = new Set();
  for (const word of value.match(WORD_RE) || []) {
    if ([...word].length > 1) tokens.add(word.toLowerCase());
  }
  const cjk = value.match(CJK_RE) || [];
  for (let index = 0; index < cjk.length - 1; index += 1) tokens.add(cjk[index] + cjk[index + 1]);
  if (cjk.length === 1) tokens.add(cjk[0]);
  return tokens;
}

// Jaccard overlap of the two texts' tokens: 1.0 is the same words, 0.0 none shared.
export function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) {
    return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase() ? 1.0 : 0.0;
  }
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

// An inflected form of a word a source had.  Both words are at least five
// characters and share a prefix of at least max(4, len(shorter) - 2); shorter
// words are never matched this way, since unrelated short words collide.
export function sameStem(word, allowed) {
  const chars = [...String(word)];
  if (chars.length < 5) return false;
  for (const known of allowed) {
    const other = [...String(known)];
    if (other.length < 5) continue;
    const need = Math.max(4, Math.min(chars.length, other.length) - 2);
    if (chars.slice(0, need).join("") === other.slice(0, need).join("")) return true;
  }
  return false;
}

// Items that share words with QUERY, rarest shared words counting most.  A
// word that is in half the items says little about which one is meant; a
// word in one says everything.  Scores are the sum of log((N + 1) / df) over
// the shared tokens, plus a bonus when the whole query appears verbatim.
// ITEMS are { id, content, createdAt }.
export function search(items, query, limit = 10) {
  const queryTokens = tokenize(query);
  if (!queryTokens.size) return items.slice(0, limit);
  const tokens = new Map(items.map((item) => [item.id, tokenize(item.content)]));
  const df = new Map();
  for (const toks of tokens.values()) for (const tok of toks) df.set(tok, (df.get(tok) || 0) + 1);
  const n = Math.max(1, items.length);
  const needle = String(query ?? "").trim().toLowerCase();
  const scored = [];
  for (const item of items) {
    let score = 0;
    for (const tok of tokens.get(item.id)) if (queryTokens.has(tok)) score += Math.log((n + 1) / df.get(tok));
    if (needle && String(item.content ?? "").toLowerCase().includes(needle)) score += Math.log(n + 1) + 1.0;
    if (score > 0) scored.push({ score, item });
  }
  scored.sort((a, b) => b.score - a.score || String(a.item.createdAt ?? "").localeCompare(String(b.item.createdAt ?? "")));
  return scored.slice(0, limit).map((entry) => entry.item);
}

// Reciprocal-rank fusion: an item near the top of both lists beats the top of one.
export function fuse(rankings, limit) {
  const score = new Map();
  const items = new Map();
  for (const ranking of rankings) {
    ranking.forEach((item, rank) => {
      score.set(item.id, (score.get(item.id) || 0) + 1.0 / (RRF_K + rank + 1));
      if (!items.has(item.id)) items.set(item.id, item);
    });
  }
  return [...score.keys()].sort((a, b) => score.get(b) - score.get(a)).slice(0, limit).map((id) => items.get(id));
}

// The entries whose score stands out from the crowd, best first.  Scores are
// corpus-dependent, so the cut is relative: above the mean, and with enough
// entries to tell, above the mean by a standard deviation.  SCORED is
// [{ score, ... }].
export function standouts(scored, limit) {
  if (!scored.length) return [];
  const values = scored.map((entry) => entry.score);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let cut = mean;
  if (values.length >= 8) {
    const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    cut = mean + std;
  }
  return scored.filter((entry) => entry.score >= cut).sort((a, b) => b.score - a.score).slice(0, limit);
}
