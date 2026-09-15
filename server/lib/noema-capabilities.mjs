import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExternalSource, validateExternalSources } from "./noema-external-capabilities.mjs";
import { applySkillDiff, createSkillDiff } from "./noema-skill-diff.mjs";

export const NOEMA_CAPABILITY_SCHEMA = "noema.capabilities/1";
export const NOEMA_CAPABILITY_FILE = "noema-capabilities.json";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCOPE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
const BUILTIN_SKILL_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../resources/skills");
const mutationQueues = new Map();

function globalPaths({ environment = process.env, userHome = homedir(), globalConfigPath, globalSkillDirectory } = {}) {
  const configFile = resolve(globalConfigPath || environment.NOEMA_GLOBAL_CAPABILITIES
    || join(userHome, ".emacs.d", "etc", "noema", "capabilities.json"));
  return { configFile, skillDirectory: resolve(globalSkillDirectory || environment.NOEMA_GLOBAL_SKILLS
    || join(dirname(configFile), "skills")) };
}

/** Install a new Skill in the chosen scope; never overwrite existing directories. */
export async function installProjectSkill({ root, scope = "project", id = "", description = "", sourceDirectory = "", ...options }) {
  const skillDirectory = scope === "global" ? globalPaths(options).skillDirectory
    : join(await realpath(root), ".agents", "skills");
  let source = "";
  if (sourceDirectory) {
    source = await realpath(sourceDirectory);
    const parsed = parseFrontmatter(await readFile(join(source, "SKILL.md"), "utf8"));
    if (parsed.error) throw capabilityError(parsed.error, "ERR_NOEMA_SKILL");
    id = String(parsed.fields.name || source.split(sep).at(-1)).trim();
  }
  if (!ID_PATTERN.test(id)) throw capabilityError("A valid Skill id is required", "ERR_NOEMA_SKILL");
  const directory = join(skillDirectory, id);
  if (source && (directory === source || directory.startsWith(source + sep))) {
    throw capabilityError("Cannot import a Skill into itself", "ERR_NOEMA_SKILL");
  }
  await mkdir(dirname(directory), { recursive: true });
  if (scope === "project" && await realpath(dirname(directory)) !== dirname(directory)) {
    throw capabilityError("Local Skill directory must not redirect through a symlink", "ERR_NOEMA_SKILL");
  }
  await mkdir(directory); // EEXIST also rejects symlinks and preserves their targets.
  try {
    if (source) {
      for (const name of await readdir(source)) {
        await cp(join(source, name), join(directory, name), { recursive: true, dereference: true, force: false, errorOnExist: true });
      }
    }
    else await writeFile(join(directory, "SKILL.md"),
      `---\nname: ${id}\ndescription: ${JSON.stringify(String(description).replace(/[\r\n]+/g, " "))}\n---\n\n# ${id}\n\nDescribe when to use this Skill and the steps to follow.\n`, { flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }); // Only our newly created directory.
    throw error;
  }
  return { id, path: join(directory, "SKILL.md") };
}

/** A project delta, or an explicitly requested independent local copy. */
export async function prepareProjectSkill({ root, id, operation, ...options }) {
  if (!ID_PATTERN.test(String(id || "")) || !["copy", "patch"].includes(operation)) {
    throw capabilityError("Choose a valid Skill id and copy or patch operation", "ERR_NOEMA_SKILL");
  }
  const projectRoot = await realpath(root);
  const global = await resolveProjectCapabilities({ ...options, scope: "global", includeContent: true });
  const shared = global.skills.find((skill) => skill.id === id);
  if (!shared?.validation.valid || !shared.source?.path) throw capabilityError("A valid global Skill is required", "ERR_NOEMA_SKILL");
  const project = await resolveProjectCapabilities({ ...options, root: projectRoot, scope: "project", includeContent: true });
  const current = project.skills.find((skill) => skill.id === id);
  if (current?.source?.scope === "project") throw capabilityError("This Skill already has a local definition; edit it on Local Skills", "ERR_NOEMA_SKILL");
  if (operation === "copy") {
    if (current?.patches.some((patch) => patch.scope === "project")) {
      throw capabilityError("Remove the project patch before making an independent local copy", "ERR_NOEMA_SKILL");
    }
    const skill = await installProjectSkill({ root: projectRoot, sourceDirectory: dirname(shared.source.path) });
    // Freeze global patches too; local edits and resources are independent.
    await writeFile(skill.path, shared.effective.content);
    return { ...skill, operation, directory: dirname(skill.path) };
  }
  const config = (await projectCapabilityConfig(projectRoot)).config;
  const previous = object(object(config.skills).patches)[id];
  if (previous?.patch_file) {
    const path = await projectSkillPatchPath(projectRoot, previous.patch_file);
    return { id, operation, path, directory: dirname(path) };
  }
  if (Array.isArray(previous)) throw capabilityError("Edit the existing patch sequence as JSON before creating a file patch", "ERR_NOEMA_SKILL");
  const directory = join(projectRoot, ".agents", "skill-patches", id);
  await mkdir(dirname(directory), { recursive: true });
  // Reject parent symlinks escaping the project before creating a workspace.
  if (await realpath(dirname(directory)) !== dirname(directory)) throw capabilityError("Patch directory must not redirect through a symlink", "ERR_NOEMA_SKILL");
  // An explicit Patch action also upgrades the old full-document override.
  // Preserve its SKILL.md and BASE.md; never overwrite user edits or backups.
  const legacy = previous?.content_file;
  if (legacy) {
    await projectSkillPatchPath(projectRoot, legacy);
    if (await realpath(directory) !== directory) throw capabilityError("Legacy patch workspace must not redirect through a symlink", "ERR_NOEMA_SKILL");
  }
  else await mkdir(directory);
  const path = join(directory, "skill.patch");
  const content = current?.effective?.content ?? shared.effective.content;
  const diff = await createSkillDiff(shared.effective.content, content);
  await applySkillDiff(shared.effective.content, diff, sha256(shared.effective.content));
  await writeFile(join(directory, "PATCH-BASE.md"), shared.effective.content, { flag: "wx", mode: 0o444 });
  await writeFile(path, diff, { flag: "wx" });
  const patch = { ...object(previous), patch_file: relative(projectRoot, path).split(sep).join("/"),
    base_sha256: sha256(shared.effective.content) };
  for (const key of ["content_file", "content", "content_append", "contentAppend"]) delete patch[key];
  await mutateProjectCapability({ root: projectRoot, type: "skill", id,
    patch });
  return { id, operation, path, directory };
}

async function projectSkillPatchPath(root, reference) {
  const path = resolve(root, String(reference));
  const patches = join(root, ".agents", "skill-patches");
  if (!pathIsInside(patches, path) || path === patches) throw capabilityError("Skill patch file must be inside .agents/skill-patches", "ERR_NOEMA_SKILL");
  const actual = await realpath(path);
  if (await realpath(patches) !== patches || !pathIsInside(patches, actual)) throw capabilityError("Skill patch file escapes its project patch directory", "ERR_NOEMA_SKILL");
  return actual;
}

function capabilityError(message, code = "ERR_NOEMA_CAPABILITY", details = {}) {
  return Object.assign(new Error(message), { statusCode: 422, code, details });
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function values(value) {
  return Array.isArray(value) ? value : [];
}

function strings(value) {
  return [...new Set(values(value).map((item) => String(item || "").trim()).filter(Boolean))];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathIsInside(root, path) {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

function displayPath(root, path) {
  return root && pathIsInside(root, path) ? relative(root, path).split(sep).join("/") : path;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function mergePatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const output = object(target) === target ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else output[key] = mergePatch(output[key], value);
  }
  return output;
}

function parseFrontmatter(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  if (!source.startsWith("---\n")) return { fields: {}, body: source.trim() };
  const end = source.indexOf("\n---", 4);
  if (end < 0) return { fields: {}, body: source.trim(), error: "unterminated YAML frontmatter" };
  const fields = {};
  for (const line of source.slice(4, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[match[1].replaceAll("-", "_")] = value;
  }
  return { fields, body: source.slice(end + 4).trim() };
}

async function readConfig(path, { optional = false } = {}) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw capabilityError(`Cannot read capability configuration ${path}: ${error?.message || error}`,
      "ERR_NOEMA_CAPABILITY_CONFIG", { source: path });
  }
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw capabilityError(`Malformed capability configuration ${path}: ${error?.message || error}`,
      "ERR_NOEMA_CAPABILITY_CONFIG", { source: path });
  }
  if (config?.schema !== NOEMA_CAPABILITY_SCHEMA) {
    throw capabilityError(`Capability configuration ${path} must use schema ${NOEMA_CAPABILITY_SCHEMA}`,
      "ERR_NOEMA_CAPABILITY_CONFIG", { source: path, field: "schema", value: config?.schema });
  }
  validateConfigShape(config, path);
  return { config, path, sha256: `sha256:${sha256(bytes)}` };
}

function validateConfigShape(config, path) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw capabilityError(`Capability configuration ${path} must be a JSON object`,
      "ERR_NOEMA_CAPABILITY_CONFIG", { source: path });
  }
  if (Object.hasOwn(config, "extends") && !Array.isArray(config.extends)) {
    throw capabilityError(`Capability configuration ${path} field extends must be an array`,
      "ERR_NOEMA_CAPABILITY_CONFIG", { source: path, field: "extends", value: config.extends });
  }
  validateExternalSources(config.sources);
  for (const [index, extension] of values(config.extends).entries()) {
    if (!extension || typeof extension !== "object" || Array.isArray(extension)
        || typeof extension.scope !== "string" || typeof extension.path !== "string") {
      throw capabilityError(`Capability configuration ${path} extends[${index}] needs string scope and path`,
        "ERR_NOEMA_CAPABILITY_SCOPE", { source: path, field: `extends.${index}`, value: extension });
    }
  }
  for (const sectionName of ["skills", "mcp"]) {
    const section = config[sectionName];
    if (section === undefined) continue;
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw capabilityError(`Capability configuration ${path} field ${sectionName} must be an object`,
        "ERR_NOEMA_CAPABILITY_CONFIG", { source: path, field: sectionName, value: section });
    }
    for (const field of ["enabled", "disabled", ...(sectionName === "skills" ? ["directories"] : [])]) {
      if (Object.hasOwn(section, field) && !Array.isArray(section[field])) {
        throw capabilityError(`Capability configuration ${path} field ${sectionName}.${field} must be an array`,
          "ERR_NOEMA_CAPABILITY_CONFIG", { source: path, field: `${sectionName}.${field}`, value: section[field] });
      }
      if (field !== "directories" && values(section[field]).some((id) => typeof id !== "string" || !ID_PATTERN.test(id))) {
        throw capabilityError(`Capability configuration ${path} field ${sectionName}.${field} contains an invalid id`,
          "ERR_NOEMA_CAPABILITY_CONFIG", { source: path, field: `${sectionName}.${field}`, value: section[field] });
      }
      if (field === "directories" && values(section[field]).some((directory) => typeof directory !== "string" || !directory.trim())) {
        throw capabilityError(`Capability configuration ${path} field skills.directories contains an invalid path`,
          "ERR_NOEMA_CAPABILITY_CONFIG", { source: path, field: "skills.directories", value: section[field] });
      }
    }
    if (Object.hasOwn(section, "patches")
        && (!section.patches || typeof section.patches !== "object" || Array.isArray(section.patches))) {
      throw capabilityError(`Capability configuration ${path} field ${sectionName}.patches must be an object`,
        "ERR_NOEMA_CAPABILITY_CONFIG", { source: path, field: `${sectionName}.patches`, value: section.patches });
    }
    for (const [id, patch] of Object.entries(object(section.patches))) {
      if (!ID_PATTERN.test(id)) {
        throw capabilityError(`Capability configuration ${path} has invalid patch id ${id}`,
          "ERR_NOEMA_CAPABILITY_PATCH", { source: path, field: `${sectionName}.patches.${id}` });
      }
      const patchList = Array.isArray(patch) ? patch : [patch];
      if (patchList.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
        throw capabilityError(`Patch ${sectionName}.${id} in ${path} must be an object or array of objects`,
          "ERR_NOEMA_CAPABILITY_PATCH", { source: path, field: `${sectionName}.patches.${id}`, value: patch });
      }
    }
  }
  const servers = config.mcp?.servers;
  if (servers !== undefined && (!servers || typeof servers !== "object")) {
    throw capabilityError(`Capability configuration ${path} field mcp.servers must be an array or object`,
      "ERR_NOEMA_CAPABILITY_CONFIG", { source: path, field: "mcp.servers", value: servers });
  }
}

function defaultConfig() {
  return {
    schema: NOEMA_CAPABILITY_SCHEMA,
    skills: { enabled: [], disabled: [], patches: {} },
    mcp: { servers: [], enabled: [], disabled: [], patches: {} },
  };
}

function normalizeMCPDefinitions(section, scope) {
  const input = section.servers;
  const entries = Array.isArray(input)
    ? input
    : Object.entries(object(input)).map(([id, definition]) => ({ ...object(definition), id }));
  return entries.map((raw, index) => {
    const definition = clone(object(raw));
    const id = String(definition.id || definition.name || "").trim();
    for (const metadata of ["id", "title", "description", "default_enabled", "defaultEnabled", "runtime_optional"]) {
      delete definition[metadata];
    }
    definition.name = String(definition.name || id).trim();
    const errors = [];
    if (!ID_PATTERN.test(id)) errors.push(`invalid MCP id: ${id || "<empty>"}`);
    const type = String(definition.type || "stdio").trim().toLowerCase();
    if (type === "http" || type === "sse") {
      definition.type = type;
      if (definition.headers === undefined) definition.headers = [];
    } else if (type === "stdio") {
      delete definition.type;
      if (definition.args === undefined) definition.args = [];
      if (definition.env === undefined) definition.env = [];
    } else {
      definition.type = type;
    }
    return {
      id, type: "mcp", title: String(raw.title || definition.name || id),
      description: String(raw.description || ""), definition: { config: definition },
      defaultEnabled: raw.default_enabled === true || raw.defaultEnabled === true,
      runtimeOptional: raw.runtime_optional === true,
      source: { scope: scope.name, scopeId: scope.id, path: scope.path, index },
      rank: scope.rank, validation: { valid: errors.length === 0, errors },
    };
  });
}

async function discoverSkills(directory, scope, projectRoot) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    return [{
      id: `invalid-${sha256(directory).slice(0, 12)}`, type: "skill", title: "Unreadable skill directory",
      description: "", definition: {}, defaultEnabled: false,
      source: { scope: scope.name, scopeId: scope.id, path: directory }, rank: scope.rank,
      validation: { valid: false, errors: [`cannot read skill directory: ${error?.message || error}`] },
    }];
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const definitions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directoryPath = join(directory, entry.name);
    const skillPath = join(directoryPath, "SKILL.md");
    let bytes;
    try {
      if (!(await stat(directoryPath)).isDirectory()) continue;
      bytes = await readFile(skillPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        definitions.push({
          id: entry.name, type: "skill", title: entry.name, description: "", definition: {},
          defaultEnabled: false,
          source: { scope: scope.name, scopeId: scope.id, path: displayPath(projectRoot, skillPath) },
          rank: scope.rank,
          validation: { valid: false, errors: [`cannot read SKILL.md: ${error?.message || error}`] },
        });
      }
      continue;
    }
    const content = bytes.toString("utf8");
    const parsed = parseFrontmatter(content);
    const id = String(parsed.fields.name || entry.name).trim();
    const errors = [];
    const warnings = [];
    if (!ID_PATTERN.test(id)) errors.push(`invalid skill id: ${id || "<empty>"}`);
    if (parsed.error) errors.push(parsed.error);
    if (!parsed.fields.name) warnings.push("SKILL.md has no name frontmatter; directory name is the stable id");
    if (!parsed.fields.description) warnings.push("SKILL.md has no description frontmatter");
    definitions.push({
      id, aliases: id === entry.name ? [] : [entry.name], type: "skill",
      title: String(parsed.fields.title || id),
      description: String(parsed.fields.description || parsed.body.split("\n").find(Boolean) || ""),
      definition: {
        content,
        configuration: {},
        path: displayPath(projectRoot, skillPath),
        content_sha256: `sha256:${sha256(bytes)}`,
      },
      defaultEnabled: parsed.fields.default_enabled === "true",
      source: { scope: scope.name, scopeId: scope.id, path: displayPath(projectRoot, skillPath) },
      rank: scope.rank, validation: { valid: errors.length === 0, errors, warnings },
    });
  }
  return definitions;
}

function canonicalID(id, aliases) {
  return aliases.get(id) || id;
}

function patchesFor(section, id, aliases) {
  return Object.entries(object(section.patches))
    .filter(([reference]) => canonicalID(reference, aliases) === id)
    .flatMap(([, patch]) => Array.isArray(patch) ? patch : patch && typeof patch === "object" ? [patch] : []);
}

function sectionFor(scope, type) {
  return object(scope.config[type === "skill" ? "skills" : "mcp"]);
}

function selectionFor(scope, type, id, aliases) {
  const section = sectionFor(scope, type);
  if (strings(section.disabled).some((reference) => canonicalID(reference, aliases) === id)) return false;
  if (strings(section.enabled).some((reference) => canonicalID(reference, aliases) === id)) return true;
  return undefined;
}

function validationAfterPatch(type, effective, prior, base) {
  const errors = [...values(prior?.errors)];
  const warnings = [...values(prior?.warnings)];
  if (type === "skill" && !String(effective.content || "").trim()) errors.push("effective skill content is empty");
  if (type === "mcp") {
    const config = object(effective.config);
    const transport = String(config.type || "stdio").toLowerCase();
    if (!["stdio", "http", "sse"].includes(transport)) errors.push(`unsupported MCP type: ${transport}`);
    if ((transport === "http" || transport === "sse") && !String(config.url || "").trim()
        && !base?.runtimeOptional) {
      errors.push(`${transport} MCP requires url`);
    }
    if ((transport === "http" || transport === "sse") && !Array.isArray(config.headers)) {
      errors.push(`${transport} MCP headers must be an array`);
    }
    if (transport === "stdio") {
      if (!String(config.command || "").trim()) errors.push("stdio MCP requires command");
      if (!Array.isArray(config.args)) errors.push("stdio MCP args must be an array");
      if (!Array.isArray(config.env)) errors.push("stdio MCP env must be an array");
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

async function executableAvailability(command, projectRoot, environment) {
  const value = String(command || "").trim();
  if (!value) return "unavailable";
  const candidates = isAbsolute(value) || value.includes(sep)
    ? [isAbsolute(value) ? value : resolve(projectRoot, value)]
    : String(environment.PATH || "").split(delimiter).filter(Boolean).map((directory) => join(directory, value));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return "available";
    } catch {
      // Try the next PATH entry.
    }
  }
  return "unavailable";
}

async function resolveType(type, scopes, definitions, runtimeSelections = []) {
  const byID = new Map();
  const aliases = new Map();
  for (const definition of definitions.filter((item) => item.type === type)) {
    if (!byID.has(definition.id)) byID.set(definition.id, []);
    byID.get(definition.id).push(definition);
    for (const alias of values(definition.aliases)) aliases.set(alias, definition.id);
  }
  for (const scope of scopes) {
    const section = sectionFor(scope, type);
    const references = [
      ...strings(section.enabled), ...strings(section.disabled),
      ...Object.keys(object(section.patches)),
    ];
    for (const reference of references) {
      const id = canonicalID(reference, aliases);
      if (!byID.has(id)) byID.set(id, []);
    }
  }
  for (const requested of runtimeSelections) {
    const id = canonicalID(requested, aliases);
    if (!byID.has(id)) byID.set(id, []);
  }
  const resolved = [];
  for (const [id, candidates] of [...byID.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    candidates.sort((left, right) => left.rank - right.rank || left.source.path.localeCompare(right.source.path));
    const duplicateScopes = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.rank}:${candidate.source.scopeId}`;
      duplicateScopes.set(key, (duplicateScopes.get(key) || 0) + 1);
    }
    const base = candidates.at(-1);
    const diagnostics = [];
    if (!base) diagnostics.push({ severity: "error", code: "unknown-capability", message: `Unknown ${type} ${id}` });
    for (const [key, count] of duplicateScopes) {
      if (count > 1) diagnostics.push({ severity: "error", code: "duplicate-definition", message: `Duplicate ${type} ${id} definitions in scope ${key.split(":").slice(1).join(":")}` });
    }
    let effective = clone(base?.definition || {});
    let enabled = Boolean(base?.defaultEnabled);
    let explicitEnabled;
    const selectedBy = base?.defaultEnabled ? [{ scope: base.source.scope, scopeId: base.source.scopeId, enabled: true, reason: "definition default" }] : [];
    const appliedPatches = [];
    for (const scope of scopes) {
      if (base && scope.rank < base.rank) continue;
      const section = sectionFor(scope, type);
      const enabledHere = strings(section.enabled).some((reference) => canonicalID(reference, aliases) === id);
      const disabledHere = strings(section.disabled).some((reference) => canonicalID(reference, aliases) === id);
      if (enabledHere && disabledHere) {
        diagnostics.push({ severity: "error", code: "selection-conflict", message: `${type} ${id} is both enabled and disabled in scope ${scope.name}` });
      }
      for (const patch of patchesFor(section, id, aliases)) {
        const raw = clone(object(patch));
        const document = type === "skill" && (raw.patch_file || raw.content_file)
          ? scope.skillPatchDocuments?.get(raw.patch_file || raw.content_file) : null;
        if (raw.patch_file !== undefined) {
          try {
            if (!document || document.error) throw new Error(document?.error || "Skill diffs must be project-scoped");
            raw.content = await applySkillDiff(String(effective.content || ""), document.content, raw.base_sha256);
            const parsed = parseFrontmatter(raw.content);
            if (parsed.error || (parsed.fields.name && parsed.fields.name !== id)) throw new Error("Skill patch cannot change its name or break frontmatter");
          } catch (error) {
            delete raw.content;
            diagnostics.push({ severity: "error", code: "invalid-skill-diff", message: error.message });
          }
          delete raw.patch_file;
          delete raw.base_sha256;
        }
        if (raw.content_file !== undefined) {
          delete raw.content_file;
          if (!document || document.error || (document.id && document.id !== id)) {
            diagnostics.push({ severity: "error", code: "invalid-skill-patch-file",
              message: document?.error || "Skill patch file has a different name or is not project-scoped" });
          } else raw.content = document.content;
        }
        const append = type === "skill" ? String(raw.content_append || raw.contentAppend || "") : "";
        delete raw.content_append;
        delete raw.contentAppend;
        const patchEnabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
        delete raw.enabled;
        for (const reserved of ["id", "type", "source", "provenance", "validation"]) {
          if (Object.hasOwn(raw, reserved)) {
            diagnostics.push({ severity: "error", code: "invalid-patch", message: `Patch for ${type} ${id} cannot replace ${reserved}` });
            delete raw[reserved];
          }
        }
        effective = mergePatch(effective, raw);
        if (append) effective.content = `${String(effective.content || "").trimEnd()}\n\n${append.trim()}\n`;
        if (patchEnabled !== undefined) enabled = explicitEnabled = patchEnabled;
        appliedPatches.push({ scope: scope.name, scopeId: scope.id, source: scope.path, patch: clone(patch),
          ...(document?.path ? { file: document.path } : {}) });
      }
      const selected = selectionFor(scope, type, id, aliases);
      if (selected !== undefined) {
        enabled = explicitEnabled = selected;
        selectedBy.push({ scope: scope.name, scopeId: scope.id, enabled: selected, reason: `${type} selection` });
      }
    }
    if (runtimeSelections.includes(id) || values(base?.aliases).some((alias) => runtimeSelections.includes(alias))) {
      if (explicitEnabled === false) {
        diagnostics.push({ severity: "error", code: "disabled-capability-requested", message: `Skill ${id} is requested by @@skill but disabled by effective project configuration` });
        selectedBy.push({ scope: "run", scopeId: "directive", enabled: false, reason: "@@skill blocked by explicit disable" });
      } else {
        enabled = true;
        selectedBy.push({ scope: "run", scopeId: "directive", enabled: true, reason: "@@skill directive" });
      }
    }
    const validation = validationAfterPatch(type, effective, base?.validation, base);
    if (diagnostics.some((item) => item.severity === "error")) validation.valid = false;
    if (type === "skill" && effective.content !== undefined) {
      effective.content_sha256 = `sha256:${sha256(effective.content)}`;
    }
    resolved.push({
      id, type, title: base?.title || id, description: base?.description || "", enabled,
      selectable: validation.valid && explicitEnabled !== false,
      source: clone(base?.source || null), effective, patches: appliedPatches,
      selectedBy, shadowedDefinitions: candidates.slice(0, -1).map((item) => clone(item.source)),
      validation, diagnostics,
    });
  }
  return resolved;
}

async function scopeFromConfig({ name, id, rank, path, config, projectRoot, defaultSkillDirectories = [] }) {
  if (!SCOPE_PATTERN.test(name)) {
    throw capabilityError(`Invalid capability scope name: ${name}`, "ERR_NOEMA_CAPABILITY_SCOPE", { source: path, scope: name });
  }
  const scope = { name, id, rank, path, config, definitions: [], skillDirectories: [] };
  // Load only explicitly registered patch documents, never scan this tree
  // or read it on the completion/redisplay path.
  scope.skillPatchDocuments = new Map();
  if (name === "project") {
    for (const entry of Object.values(object(object(config.skills).patches))) {
      for (const patch of Array.isArray(entry) ? entry : [entry]) {
        const reference = patch?.patch_file || patch?.content_file;
        if (!reference || scope.skillPatchDocuments.has(reference)) continue;
        try {
          const file = await projectSkillPatchPath(projectRoot, reference);
          if ((await stat(file)).size > 1024 * 1024) throw new Error("Skill patch exceeds 1 MiB");
          const content = await readFile(file, "utf8");
          const parsed = patch.patch_file ? { fields: {} } : parseFrontmatter(content);
          if (parsed.error) throw new Error(parsed.error);
          scope.skillPatchDocuments.set(reference, { path: file, content, id: parsed.fields.name });
        } catch (error) {
          scope.skillPatchDocuments.set(reference, { error: `Cannot load Skill patch: ${error.message}` });
        }
      }
    }
  }
  const configuredDirectories = strings(object(config.skills).directories);
  for (const directory of [...new Set([...defaultSkillDirectories, ...configuredDirectories])]) {
    const absolute = isAbsolute(directory) ? directory : resolve(dirname(path), directory);
    scope.skillDirectories.push(absolute);
    scope.definitions.push(...await discoverSkills(absolute, scope, projectRoot));
  }
  scope.definitions.push(...normalizeMCPDefinitions(object(config.mcp), scope));
  return scope;
}

async function buildScopes({ root, runtimeDescriptor, environment, userHome, builtinSkillDirectory, globalConfigPath, globalSkillDirectory }) {
  const projectPath = root ? join(root, NOEMA_CAPABILITY_FILE) : null;
  const projectSource = root ? await readConfig(projectPath, { optional: true }) : null;
  const projectConfig = projectSource?.config || defaultConfig();
  if (projectConfig.sources !== undefined) {
    throw capabilityError("Native capability sources belong in the global library configuration", "ERR_NOEMA_CAPABILITY_SCOPE");
  }
  const builtinConfig = {
    schema: NOEMA_CAPABILITY_SCHEMA,
    skills: {},
    mcp: {
      servers: root ? [{
        id: "noema", name: "noema", title: "Noema MCP", description: "Project-local Noema semantic and research tools",
        type: "http", url: String(runtimeDescriptor?.mcpUrl || ""), default_enabled: true, runtime_optional: true,
      }] : [],
    },
  };
  const scopes = [await scopeFromConfig({
    name: "builtin", id: "noema", rank: 0, path: "builtin:noema", config: builtinConfig,
    projectRoot: root, defaultSkillDirectories: [builtinSkillDirectory],
  })];
  const { configFile: globalPath, skillDirectory: globalSkills } = globalPaths({
    environment, userHome, globalConfigPath, globalSkillDirectory });
  const globalSource = await readConfig(globalPath, { optional: true });
  const globalConfig = globalSource?.config || { schema: NOEMA_CAPABILITY_SCHEMA, skills: {}, mcp: {} };
  const libraries = [];
  let externalRank = 1;
  for (const source of values(globalConfig.sources)) {
    const library = await loadExternalSource(source, dirname(globalPath), environment);
    const scope = await scopeFromConfig({
      name: library.name, id: library.id, rank: externalRank++, path: library.path || globalPath,
      config: library.config, projectRoot: root, defaultSkillDirectories: library.directories,
    });
    for (const definition of scope.definitions) {
      if (definition.type !== "mcp") continue;
      definition.validation.errors.push(...(library.errors.get(definition.id) || []));
      definition.validation.valid = definition.validation.errors.length === 0;
    }
    scopes.push(scope);
    libraries.push({ id: library.id, scope: library.name, format: library.format, configFile: library.path,
      skillDirectories: library.directories, state: library.state, count: scope.definitions.length });
  }
  scopes.push(await scopeFromConfig({
    name: "global", id: "user", rank: 100, path: globalPath, config: globalConfig,
    projectRoot: root, defaultSkillDirectories: [globalSkills],
  }));
  if (!root) return { scopes, projectPath: globalPath, libraries };
  let rank = 200;
  const scopeNames = new Set(["builtin", "global", "project", "run", ...libraries.map((library) => library.scope)]);
  for (const extension of values(projectConfig.extends)) {
    const scopeName = String(extension?.scope || "").trim();
    const reference = String(extension?.path || "").trim();
    if (!scopeName || !reference) {
      throw capabilityError(`Every ${NOEMA_CAPABILITY_FILE} extends entry needs scope and path`,
        "ERR_NOEMA_CAPABILITY_SCOPE", { source: projectPath, value: extension });
    }
    if (scopeNames.has(scopeName)) {
      throw capabilityError(`Capability scope name ${scopeName} is reserved or duplicated`,
        "ERR_NOEMA_CAPABILITY_SCOPE", { source: projectPath, scope: scopeName });
    }
    scopeNames.add(scopeName);
    const path = isAbsolute(reference) ? reference : resolve(root, reference);
    const source = await readConfig(path);
    scopes.push(await scopeFromConfig({
      name: scopeName, id: `${scopeName}:${path}`, rank: rank++, path, config: source.config, projectRoot: root,
    }));
  }
  scopes.push(await scopeFromConfig({
    name: "project", id: root, rank: 1000, path: projectPath, config: projectConfig,
    projectRoot: root, defaultSkillDirectories: [join(root, ".agents", "skills")],
  }));
  return { scopes, projectPath, projectConfig, libraries };
}

function publicCapability(capability, includeContent) {
  const result = clone(capability);
  if (!includeContent && result.type === "skill" && result.effective) delete result.effective.content;
  return result;
}

export async function resolveProjectCapabilities({
  root,
  scope = "project",
  requestedSkills = [],
  runtimeDescriptor = {},
  environment = process.env,
  userHome = homedir(),
  builtinSkillDirectory = BUILTIN_SKILL_DIRECTORY,
  globalConfigPath,
  globalSkillDirectory,
  includeContent = false,
} = {}) {
  const projectRoot = scope === "global" ? null : await realpath(resolve(root || "."));
  const { scopes, projectPath, libraries } = await buildScopes({
    root: projectRoot, runtimeDescriptor, environment, userHome, builtinSkillDirectory, globalConfigPath, globalSkillDirectory,
  });
  const definitions = scopes.flatMap((scope) => scope.definitions);
  const skills = await resolveType("skill", scopes, definitions, strings(requestedSkills));
  const mcps = await resolveType("mcp", scopes, definitions);
  for (const mcp of mcps) {
    const config = object(mcp.effective?.config);
    if (mcp.id === "noema") {
      const availability = config.url ? "available" : "unavailable";
      mcp.runtime = { state: availability, availability, running: Boolean(config.url), connected: null, observed: true };
    } else {
      const transport = String(config.type || "stdio").toLowerCase();
      const availability = transport === "stdio"
        ? await executableAvailability(config.command, projectRoot || dirname(projectPath), environment)
        : "unknown";
      mcp.runtime = { state: "not-observed", availability, running: null, connected: null, observed: false };
    }
  }
  const all = [...skills, ...mcps];
  const diagnostics = all.flatMap((capability) => [
    ...capability.diagnostics.map((item) => ({ ...item, id: capability.id, type: capability.type })),
    ...capability.validation.errors.map((message) => ({ severity: "error", code: "invalid-definition", message, id: capability.id, type: capability.type })),
    ...capability.validation.warnings.map((message) => ({ severity: "warning", code: "definition-warning", message, id: capability.id, type: capability.type })),
  ]);
  return {
    schema: "noema.capability-resolution/1",
    scope: projectRoot ? "project" : "global",
    projectRoot,
    configFile: projectPath,
    scopes: scopes.map((scope) => ({ name: scope.name, id: scope.id, rank: scope.rank, source: scope.path,
      skillDirectories: scope.skillDirectories })),
    libraries,
    skills: skills.map((item) => publicCapability(item, includeContent)),
    mcps: mcps.map((item) => publicCapability(item, includeContent)),
    active: {
      skills: skills.filter((item) => item.enabled).map((item) => item.id),
      mcps: mcps.filter((item) => item.enabled).map((item) => item.id),
    },
    diagnostics: [...diagnostics, ...libraries.filter((library) => library.state === "error").map((library) => ({
      severity: "warning", code: "external-library-error", message: `Cannot read or parse ${library.id} configuration`,
    }))],
  };
}

export function assertRunnableCapabilities(environment) {
  const blockedRequest = values(environment.diagnostics).find((item) => item.severity === "error"
    && item.code === "disabled-capability-requested");
  if (blockedRequest) {
    throw capabilityError(blockedRequest.message, "ERR_NOEMA_SKILL",
      { capability: blockedRequest.id, type: blockedRequest.type });
  }
  for (const capability of [...values(environment.skills), ...values(environment.mcps)]) {
    if (!capability.enabled) continue;
    if (!capability.validation?.valid) {
      const reason = capability.validation?.errors?.[0] || capability.diagnostics?.[0]?.message || "invalid configuration";
      throw capabilityError(`Enabled ${capability.type} ${capability.id} is invalid: ${reason}`,
        `ERR_NOEMA_${capability.type.toUpperCase()}`, { capability: capability.id, type: capability.type, source: capability.source });
    }
    if (capability.type === "mcp" && capability.id !== "noema"
        && capability.runtime?.availability === "unavailable") {
      throw capabilityError(`Enabled MCP ${capability.id} is unavailable`, "ERR_NOEMA_MCP", { capability: capability.id });
    }
  }
  return environment;
}

export function resolvedSkillsForRun(environment) {
  const skills = [];
  const items = [];
  for (const skill of values(environment.skills).filter((item) => item.enabled)) {
    const content = String(skill.effective?.content || "");
    const digest = String(skill.effective?.content_sha256 || `sha256:${sha256(content)}`);
    const path = String(skill.effective?.path || skill.source?.path || "");
    const absolutePath = isAbsolute(path) ? path : resolve(environment.projectRoot, path);
    // The agent receives the frozen document, not a native plugin installation.
    // Keep the source hash distinct from the delivered wrapper hash.
    const delivered = `Noema Skill source: ${JSON.stringify(absolutePath)}\n`
      + `Resolve this Skill's relative resource paths from ${JSON.stringify(dirname(absolutePath))}.\n\n${content}`;
    const deliveredDigest = `sha256:${sha256(delivered)}`;
    skills.push({
      id: skill.id,
      path,
      sha256: digest,
      source: clone(skill.source),
      scope: skill.source?.scope || "",
      configuration: clone(skill.effective?.configuration || {}),
      patches: clone(skill.patches || []),
    });
    items.push({
      ref: `skill:${skill.id}`,
      resolvedUri: `noema://skill/${encodeURIComponent(skill.id)}/${deliveredDigest.replace(/^sha256:/, "")}`,
      contentBase64: Buffer.from(delivered).toString("base64"),
      mediaType: "text/markdown; charset=utf-8",
      sha256: deliveredDigest,
      bytes: Buffer.byteLength(delivered),
      truncated: false,
    });
  }
  return { skills, items };
}

export function resolvedMCPServersForRun(environment) {
  return values(environment.mcps)
    .filter((item) => item.enabled && item.validation?.valid
      && item.runtime?.state !== "unavailable" && item.runtime?.availability !== "unavailable")
    .map((item) => ({ ...clone(object(item.effective?.config)), name: item.id }));
}

async function writeConfigAtomically(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, path);
}

function updateSelection(section, id, enabled) {
  const on = strings(section.enabled).filter((item) => item !== id);
  const off = strings(section.disabled).filter((item) => item !== id);
  (enabled ? on : off).push(id);
  section.enabled = on;
  section.disabled = off;
}

export async function mutateProjectCapability({ root, scope = "project", type, id, enabled, patch, definition, ...options } = {}) {
  const projectRoot = scope === "global" ? null : await realpath(resolve(root || "."));
  const capabilityType = type === "mcp" ? "mcp" : type === "skill" ? "skill" : "";
  const capabilityID = String(id || "").trim();
  if (!capabilityType || !ID_PATTERN.test(capabilityID)) {
    throw capabilityError(`Capability mutation needs a valid type and id`, "ERR_NOEMA_CAPABILITY_MUTATION",
      { type, id });
  }
  const path = projectRoot ? join(projectRoot, NOEMA_CAPABILITY_FILE) : globalPaths(options).configFile;
  const previous = mutationQueues.get(path) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const source = await readConfig(path, { optional: true });
    const config = source?.config || defaultConfig();
    const key = capabilityType === "skill" ? "skills" : "mcp";
    config[key] = object(config[key]);
    const section = config[key];
    if (typeof enabled === "boolean") updateSelection(section, capabilityID, enabled);
    if (patch === null) {
      section.patches = object(section.patches);
      delete section.patches[capabilityID];
    } else if (patch !== undefined) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw capabilityError(`Patch for ${capabilityType} ${capabilityID} must be an object or null`,
          "ERR_NOEMA_CAPABILITY_PATCH", { type: capabilityType, id: capabilityID, value: patch });
      }
      section.patches = object(section.patches);
      section.patches[capabilityID] = clone(patch);
    }
    if (capabilityType === "mcp" && definition !== undefined) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
        throw capabilityError(`MCP definition ${capabilityID} must be an object`, "ERR_NOEMA_MCP", { id: capabilityID });
      }
      const servers = Array.isArray(section.servers)
        ? section.servers
        : Object.entries(object(section.servers)).map(([serverID, server]) => ({ ...object(server), id: serverID }));
      section.servers = [...servers.filter((item) => String(item?.id || item?.name || "") !== capabilityID),
        { ...clone(definition), id: capabilityID }];
    }
    await writeConfigAtomically(path, config);
    return { projectRoot, configFile: path, mutation: { type: capabilityType, id: capabilityID, enabled, patch, definition } };
  });
  mutationQueues.set(path, operation);
  try {
    return await operation;
  } finally {
    if (mutationQueues.get(path) === operation) mutationQueues.delete(path);
  }
}

export async function projectCapabilityConfig(root, options = {}) {
  const projectRoot = options.scope === "global" ? null : await realpath(resolve(root || "."));
  const path = projectRoot ? join(projectRoot, NOEMA_CAPABILITY_FILE) : globalPaths(options).configFile;
  const source = await readConfig(path, { optional: true });
  return { projectRoot, configFile: path, exists: Boolean(source), config: source?.config || defaultConfig() };
}
