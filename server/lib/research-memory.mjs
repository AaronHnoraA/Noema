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

/** Return a small set of current, evidence-backed Findings relevant to PROMPT. */
export function selectRunMemory(findings, prompt, workstreamId, { maxResults = 3, maxBytes = 3600 } = {}) {
  const terms = memoryTerms(prompt);
  // Keep a bounded query while retaining the current request when a work
  // block begins with a long list of background identifiers or references.
  const query = terms.length <= 32 ? terms : [...terms.slice(0, 16), ...terms.slice(-16)];
  if (!workstreamId || query.length < 2) return [];
  const querySet = new Set(query);
  const ranked = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (finding?.workstreamId !== workstreamId || !ELIGIBLE_STATUSES.has(finding?.status)
        || !ELIGIBLE_VERIFICATION.has(finding?.verificationLevel)
        || finding?.disclosure === "local_only" || !Array.isArray(finding?.evidence) || finding.evidence.length === 0) continue;
    const statement = String(finding.statement || "").trim();
    const id = String(finding.id || "").trim();
    if (!id || !statement) continue;
    const terms = memoryTerms(statement);
    if (terms.length < 2) continue;
    const matches = terms.filter((term) => querySet.has(term));
    // Three matching terms and at least half the candidate's vocabulary keep
    // long prompts and generic shared words from injecting distractors.
    if (matches.length < 3 || matches.length / terms.length < 0.5) continue;
    ranked.push({ finding, statement, score: matches.length / terms.length, matches: matches.length });
  }
  ranked.sort((left, right) => right.score - left.score || right.matches - left.matches
    || String(left.finding.id).localeCompare(String(right.finding.id)));
  const selected = [];
  let used = 0;
  for (const { finding, statement } of ranked) {
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
    used += size;
    if (selected.length >= maxResults) break;
  }
  return selected;
}
