// Progressive Agent access to the existing Skill/Packs manager authority.
import { isAbsolute } from "node:path";
import { resolveProjectCapabilities } from "./noema-capabilities.mjs";

// Project-chosen and explicitly requested Skills stay in the catalog; a Skill
// that is only globally enabled is available to Runs, not disclosed on every turn.
function catalogSkills(resolution) {
  const { skills, scopes } = resolution;
  const globalIndex = scopes.findIndex((scope) => scope.name === "global");
  const selections = new Set(["catalog", "run", ...scopes.slice(globalIndex + 1).map((scope) => scope.name)]);
  const packs = resolution.packs.filter((pack) => pack.enabled && pack.selectedBy.some((selection) =>
    selection.enabled && selections.has(selection.scope)));
  const packIds = new Set(packs.map((pack) => pack.id));
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const pending = skills.filter((skill) => skill.selectedBy.some((selection) =>
    selection.enabled && (selection.scope === "pack" ? packIds.has(selection.scopeId) : selections.has(selection.scope))))
    .map((skill) => skill.id);
  const chosen = new Set();
  // A dependency that is already enabled records no selection of its own.
  while (pending.length) {
    const id = pending.pop();
    if (chosen.has(id)) continue;
    chosen.add(id);
    pending.push(...(byId.get(id)?.effective?.requires || []));
  }
  return { chosen, packs };
}

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

async function resolve(body, options, includeContent) {
  const scope = body.scope || (body.root ? "project" : "global");
  if (!["global", "project"].includes(scope)) fail("Use global or project scope");
  if (scope === "project" && (typeof body.root !== "string" || !isAbsolute(body.root)))
    fail("An absolute project root is required");
  const requested = body.requestedSkills ?? [];
  const requestedPacks = body.requestedPacks ?? [];
  if (!Array.isArray(requested) || requested.some((id) => typeof id !== "string"))
    fail("requestedSkills must be an array of Skill ids");
  if (!Array.isArray(requestedPacks) || requestedPacks.some((id) => typeof id !== "string"))
    fail("requestedPacks must be an array of existing pack ids");
  return resolveProjectCapabilities({ ...options, root: body.root, scope, includeContent,
    requestedPacks, includeAgentCatalog: body.requestedPacks === undefined,
    requestedSkills: [...new Set([...requested, ...(includeContent ? [body.id] : [])])] });
}

export async function listAgentSkills(body = {}, options = {}) {
  const resolution = await resolve(body, options, false);
  const { chosen, packs } = catalogSkills(resolution);
  const relevant = new Set([...(body.requestedSkills ?? []), ...(body.requestedPacks ?? []),
    ...packs.map((pack) => pack.id)]);
  for (const id of chosen) relevant.add(id);
  for (const pack of resolution.packs.filter((pack) => relevant.has(pack.id)))
    for (const id of pack.effective.members) relevant.add(id);
  return { scope: resolution.scope, root: resolution.projectRoot,
    packs: packs.filter((pack) => pack.validation.valid).map((pack) => ({
      id: pack.id, members: pack.effective?.members || [], preamble: pack.effective?.preamble || "",
    })),
    skills: resolution.skills.filter((skill) => chosen.has(skill.id) && skill.enabled && skill.validation.valid).map((skill) => ({
      id: skill.id, description: skill.description || "", source: skill.source?.path,
    })),
    diagnostics: resolution.diagnostics.filter((item) => item.type !== "mcp" && relevant.has(item.id))
      .map(({ id, severity, code }) => ({ id, severity, code })),
  };
}

export async function readAgentSkill(body = {}, options = {}) {
  if (typeof body.id !== "string" || !body.id) fail("A Skill id is required");
  const resolution = await resolve(body, options, true);
  const skill = resolution.skills.find((item) => item.id === body.id);
  if (!skill?.source) fail("Unknown Skill", 404);
  if (!skill.enabled || !skill.validation.valid) fail("Skill is disabled or invalid in this scope", 409);
  return { id: skill.id, root: resolution.projectRoot, source: skill.source?.path,
    sourceScope: skill.source?.scope, content: skill.effective.content,
    digest: skill.effective.content_sha256 };
}
