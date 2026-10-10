// Token overlap for Wiki titles and search terms.  Words are compared in
// alphabetic scripts; CJK text has no spaces, so it is compared by adjacent
// character pairs inside each run.

const CJK_CLASS = "\\u2e80-\\u9fff\\uf900-\\ufaff";
const WORD_RE = new RegExp(`(?:(?![${CJK_CLASS}])[\\p{L}\\p{N}])+`, "gu");
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]+`, "gu");
const NUMBER_RE = /\p{N}+/gu;
const LETTER_RE = /\p{L}/u;

function fold(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

export function tokenize(value) {
  const text = fold(value);
  const tokens = new Set();
  for (const word of text.match(WORD_RE) || []) {
    if ([...word].length > 1) tokens.add(word);
  }
  for (const run of text.match(CJK_RUN_RE) || []) {
    const chars = [...run];
    if (chars.length === 1) tokens.add(chars[0]);
    for (let index = 0; index < chars.length - 1; index += 1) tokens.add(chars[index] + chars[index + 1]);
  }
  return tokens;
}

// English plural and verb endings only; anything subtler is the author's call.
function singular(token) {
  if (!/^[a-z]{4,}$/.test(token)) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

// Inverse document frequency: a term in half the pages says little about
// which page is meant, a term in one page says everything.
export function rareTokenWeight(population, documentFrequency) {
  return Math.log((Math.max(1, Number(population) || 0) + 1) / Math.max(1, Number(documentFrequency) || 0));
}

// The entries scoring at least the mean, best first.  Partial matches have
// no absolute scale, so the cut is relative to the result set.
export function aboveAverage(scored, limit = Infinity) {
  if (!scored.length) return [];
  const mean = scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length;
  return scored.filter((entry) => entry.score >= mean - 1e-9)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function titleNumbers(value) {
  return (fold(value).match(NUMBER_RE) || []).sort().join(" ");
}

// How alike two page titles are, 0 to 1: the share of tokens they have in
// common.  Titles that differ in a number are different pages ("Lecture 1" /
// "Lecture 2", two daily notes).
export function titleSimilarity(left, right) {
  if (titleNumbers(left) !== titleNumbers(right)) return 0;
  const a = new Set([...tokenize(left)].map(singular));
  const b = new Set([...tokenize(right)].map(singular));
  if (!a.size || !b.size) return fold(left).trim() && fold(left).trim() === fold(right).trim() ? 1 : 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function noteNames(note) {
  return note?.kind === "redirect" ? [] : [note?.title, ...(note?.aliases || [])].map((value) => String(value || "").trim()).filter(Boolean);
}

function bestNameScore(title, note) {
  let score = 0;
  let name = "";
  for (const candidate of noteNames(note)) {
    const value = titleSimilarity(title, candidate);
    if (value > score) { score = value; name = candidate; }
  }
  return { score, name };
}

export const SIMILAR_TITLE_THRESHOLD = 0.6;
export const SIMILAR_PAGE_THRESHOLD = 0.8;

// Pages whose title or alias says roughly what TITLE says, most alike first.
// A title with no letters (a date, a number) is not compared.
export function similarTitles(title, notes, options = {}) {
  const wanted = String(title || "").trim();
  if (!wanted || !LETTER_RE.test(wanted)) return [];
  const threshold = Number(options.threshold) || SIMILAR_TITLE_THRESHOLD;
  const limit = Math.max(1, Number(options.limit) || 3);
  const found = [];
  for (const note of notes || []) {
    const { score, name } = bestNameScore(wanted, note);
    if (score >= threshold) found.push({ note, score, name });
  }
  return found.sort((a, b) => b.score - a.score || String(a.note.title || "").localeCompare(String(b.note.title || ""))).slice(0, limit);
}

const PAIR_TOKEN_FANOUT = 64;

// Pairs of pages that look like one page written twice.  Only pages sharing
// a token are compared; a token carried by many pages says nothing about any
// pair and is skipped, which keeps this near linear.
export function similarTitlePairs(notes, options = {}) {
  const threshold = Number(options.threshold) || SIMILAR_PAGE_THRESHOLD;
  const limit = Math.max(1, Number(options.limit) || 200);
  const pages = (notes || []).filter((note) => noteNames(note).some((name) => LETTER_RE.test(name)));
  const buckets = new Map();
  pages.forEach((note, position) => {
    const keys = new Set();
    for (const name of noteNames(note)) for (const token of tokenize(name)) keys.add(singular(token));
    for (const key of keys) {
      const bucket = buckets.get(key) || [];
      bucket.push(position);
      buckets.set(key, bucket);
    }
  });
  const seen = new Set();
  const pairs = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > PAIR_TOKEN_FANOUT) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const key = `${bucket[i]}:${bucket[j]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const left = pages[bucket[i]];
        const right = pages[bucket[j]];
        if (left.file && left.file === right.file) continue;
        let score = 0;
        for (const name of noteNames(left)) score = Math.max(score, bestNameScore(name, right).score);
        if (score >= threshold) pairs.push({ left, right, score });
      }
    }
  }
  return pairs.sort((a, b) => b.score - a.score
    || String(a.left.title || "").localeCompare(String(b.left.title || ""))
    || String(a.right.title || "").localeCompare(String(b.right.title || ""))).slice(0, limit);
}
