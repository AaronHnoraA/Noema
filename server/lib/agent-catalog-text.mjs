// The Skill catalog as Pi's system prompt carries it.  It is sent on every turn,
// so it says only what choosing a Skill needs: `agent:skill:read` has the rest.
export function renderAgentCatalog(catalog) {
  const skills = new Map(catalog.skills.map((skill) => [skill.id, skill]));
  const listed = new Set();
  const line = (id) => { listed.add(id); const skill = skills.get(id); return skill ? `- ${id}: ${skill.description}` : null; };
  const parts = catalog.packs.map((pack) => [`## ${pack.id}`, pack.preamble, ...pack.members.map(line)].filter(Boolean).join("\n"));
  const others = catalog.skills.filter((skill) => !listed.has(skill.id)).map((skill) => line(skill.id));
  if (others.length) parts.push(others.join("\n"));
  if (catalog.diagnostics.length) parts.push(`Diagnostics: ${JSON.stringify(catalog.diagnostics)}`);
  return `Scope: ${catalog.root ?? catalog.scope}\n${parts.join("\n\n")}`;
}
