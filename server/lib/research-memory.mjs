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
  for (const match of normalized.matchAll(/[a-z][a-z0-9_.:/-]{2,}|[0-9][a-z0-9_.:/-]{2,}/gu)) {
    if (!COMMON_TERMS.has(match[0])) terms.push(match[0]);
  }
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const chars = [...match[0]];
    for (let index = 0; index + 1 < chars.length; index++) {
      const term = chars[index] + chars[index + 1];
      if (!COMMON_TERMS.has(term)) terms.push(term);
    }
  }
  return [...new Set(terms)];
}

/** Return a small set of current, evidence-backed Findings relevant to PROMPT. */
export function selectRunMemory(findings, prompt, workstreamId, { maxResults = 3, maxChars = 3600 } = {}) {
  const query = memoryTerms(prompt).slice(0, 32);
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
    const size = [...content].length;
    if (used + size > maxChars) continue;
    selected.push({ id: finding.id, version: finding.version, content });
    used += size;
    if (selected.length >= maxResults) break;
  }
  return selected;
}
