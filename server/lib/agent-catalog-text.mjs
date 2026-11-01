// The Skill catalog as Pi's system prompt carries it.  It is sent on every turn,
// so it says only what choosing a Skill needs: `agent:skill:read` has the rest.
export function renderAgentCatalog({ scope, root, packs = [], skills: entries = [], diagnostics = [] }) {
  const skills = new Map(entries.map((skill) => [skill.id, skill]));
  const listed = new Set();
  const line = (id) => { listed.add(id); const skill = skills.get(id); return skill ? `- ${id}: ${skill.description}` : null; };
  const parts = packs.map((pack) => [`## ${pack.id}`, pack.preamble, ...(pack.members ?? []).map(line)].filter(Boolean).join("\n"));
  const others = entries.filter((skill) => !listed.has(skill.id)).map((skill) => line(skill.id));
  if (others.length) parts.push(others.join("\n"));
  if (diagnostics.length) parts.push(`Diagnostics: ${JSON.stringify(diagnostics)}`);
  return `Scope: ${root ?? scope ?? "unknown"}\n${parts.join("\n\n")}`;
}
