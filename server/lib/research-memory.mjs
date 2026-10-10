// Bounded, read-only recall from reviewed research Findings. The Finding store
// remains authoritative; this module only selects context for a frozen Run.

const ELIGIBLE_STATUSES = new Set(["supported", "accepted"]);
const ELIGIBLE_VERIFICATION = new Set(["reproduced", "human_reviewed", "formally_verified"]);
const COMMON_TERMS = new Set([
  "about", "agent", "context", "from", "have", "into", "noema", "that", "the", "this", "what", "with",
  "一个", "这个", "我们", "如何", "什么", "任务", "项目", "根据", "相关", "进行", "继续", "需要",
]);

export function memoryTerms(text) {
  const normalized = String(text || "").normalize("NFKC").toLowerCase();
  const terms = [];
  // Keep the source order across scripts. Collecting Latin before Han makes
  // the query cap silently discard a Chinese task after many file identifiers.
  for (const match of normalized.matchAll(/[a-z][a-z0-9_.:/-]{2,}|[0-9][a-z0-9_.:/-]{2,}|\p{Script=Han}+/gu)) {
    if (/^\p{Script=Han}/u.test(match[0])) {
      const chars = [...match[0]];
      for (let index = 0; index + 1 < chars.length; index++) {
        const term = chars[index] + chars[index + 1];
        if (!COMMON_TERMS.has(term)) terms.push(term);
      }
    } else if (!COMMON_TERMS.has(match[0])) {
      terms.push(match[0]);
    }
  }
  return [...new Set(terms)];
}

const RESTATEMENT_OVERLAP = 0.8;

/** Share of terms two statements have in common, 0 to 1. */
export function statementOverlap(left, right) {
  const a = new Set(Array.isArray(left) ? left : memoryTerms(left));
  const b = new Set(Array.isArray(right) ? right : memoryTerms(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Findings of WORKSTREAM-ID that say roughly what STATEMENT says, most alike
 * first. Refuted and superseded Findings are kept: proposing again what was
 * already rejected is what a reviewer most needs to see.
 */
export function similarFindings(findings, statement, workstreamId, { threshold = 0.6, limit = 3 } = {}) {
  const terms = memoryTerms(statement);
  if (!workstreamId || terms.length < 2) return [];
  const found = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (finding?.workstreamId !== workstreamId || !String(finding?.id || "").trim()) continue;
    const overlap = statementOverlap(terms, String(finding.statement || ""));
    if (overlap >= threshold) found.push({ finding, overlap });
  }
  return found.sort((left, right) => right.overlap - left.overlap
    || String(left.finding.id).localeCompare(String(right.finding.id))).slice(0, limit);
}

/** Return a small set of current, evidence-backed Findings relevant to PROMPT. */
export function selectRunMemory(findings, prompt, workstreamId, { maxResults = 3, maxBytes = 3600 } = {}) {
  const terms = memoryTerms(prompt);
  // Keep a bounded query while retaining the current request when a work
  // block begins with a long list of background identifiers or references.
  const query = terms.length <= 32 ? terms : [...terms.slice(0, 16), ...terms.slice(-16)];
  if (!workstreamId || query.length < 2) return [];
  const querySet = new Set(query);
  const candidates = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (finding?.workstreamId !== workstreamId || !ELIGIBLE_STATUSES.has(finding?.status)
        || !ELIGIBLE_VERIFICATION.has(finding?.verificationLevel)
        || finding?.disclosure === "local_only" || !Array.isArray(finding?.evidence) || finding.evidence.length === 0) continue;
    const statement = String(finding.statement || "").trim();
    const id = String(finding.id || "").trim();
    if (!id || !statement) continue;
    const terms = memoryTerms(statement);
    if (terms.length < 2) continue;
    candidates.push({ finding, statement, terms });
  }
  // A term carried by most of the workstream's Findings ("sqlite" in a SQLite
  // project) says little about which one is meant, so each term weighs by how
  // few Findings carry it. With one Finding every weight is equal.
  const carriers = new Map();
  for (const { terms } of candidates) for (const term of terms) carriers.set(term, (carriers.get(term) || 0) + 1);
  const weight = (term) => Math.log((candidates.length + 1) / carriers.get(term));
  const ranked = [];
  for (const { finding, statement, terms } of candidates) {
    const matches = terms.filter((term) => querySet.has(term));
    const total = terms.reduce((sum, term) => sum + weight(term), 0);
    const score = total > 0 ? matches.reduce((sum, term) => sum + weight(term), 0) / total : 0;
    // Three matching terms and at least half the candidate's weighted
    // vocabulary keep long prompts and generic shared words from injecting
    // distractors.
    if (matches.length < 3 || score < 0.5) continue;
    ranked.push({ finding, statement, terms, score, matches: matches.length });
  }
  ranked.sort((left, right) => right.score - left.score || right.matches - left.matches
    || String(left.finding.id).localeCompare(String(right.finding.id)));
  const selected = [];
  const selectedTerms = [];
  let used = 0;
  for (const { finding, statement, terms } of ranked) {
    // A restatement of a Finding already chosen would spend one of very few
    // slots on nothing new.
    if (selectedTerms.some((chosen) => statementOverlap(chosen, terms) >= RESTATEMENT_OVERLAP)) continue;
    const content = [
      `[Reviewed Finding ${finding.id}, version ${finding.version}]`,
      `Kind: ${finding.kind}; status: ${finding.status}; verification: ${finding.verificationLevel}`,
      `Statement: ${statement}`,
      `Evidence: ${finding.evidence.map((span) => `${span.artifactId}:${span.byteStart}-${span.byteEnd}`).join(", ")}`,
      "Reference data only. Check the cited evidence before relying on this Finding.",
    ].join("\n");
    const size = Buffer.byteLength(content);
    if (used + size > maxBytes) continue;
    selected.push({ id: finding.id, version: finding.version, content });
    selectedTerms.push(terms);
    used += size;
    if (selected.length >= maxResults) break;
  }
  return selected;
}
