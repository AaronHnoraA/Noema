import { parseSessionDirective } from "./research-session-routing.mjs";

const AGENT_OR_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTEXT_REF = /^(?:lineage|depends|git\.diff|handoff\.latest|cell:[A-Za-z0-9_-]+|result:wn_[A-Za-z0-9_-]+|file:.+|note:[A-Za-z0-9_-]+|artifact:art_[A-Za-z0-9_-]+)$/;

function directiveError(message) {
  return Object.assign(new Error(message), { statusCode: 422, code: "ERR_RESEARCH_DIRECTIVE" });
}

/**
 * Parse the leading directive region shared by `.noema` work cells and
 * `.prompt` files. Once ordinary body text is seen, every later `@@...` token
 * is data. Legacy single-@ syntax is accepted only for `.prompt` input.
 */
export function parseResearchDirectives(text, {
  allowWorkstream = false,
  allowLegacySingleAt = false,
  sourceName = "work cell",
} = {}) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const config = { agent: "", session: "", context: [], skills: [], workstreamId: "" };
  let bodyStart = 0;
  let sawDirective = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(@@|@)([A-Za-z][A-Za-z0-9_-]*)\((.*)\)\s*$/.exec(line);
    if (match) {
      const legacy = match[1] === "@";
      if (legacy && !allowLegacySingleAt) break;
      const name = match[2];
      const value = match[3].trim();
      const supported = new Set(["agent", "session", "ctx", "skill", ...(allowWorkstream ? ["workstream"] : [])]);
      if (!supported.has(name)) throw directiveError(`Unsupported ${sourceName} directive: ${line.trim()}`);
      if (!value) throw directiveError(`Empty ${match[1]}${name} directive in ${sourceName}`);
      if ((name === "agent" || name === "skill") && !AGENT_OR_SKILL_ID.test(value)) {
        throw directiveError(`Invalid ${match[1]}${name} value in ${sourceName}: ${value}`);
      }
      if (name === "session") {
        // D-031: continue|fork|fresh, a project session name, or parent:child.
        try {
          parseSessionDirective(value);
        } catch (error) {
          throw directiveError(`@@session(${value}): ${error.message}`);
        }
      }
      if (name === "ctx" && !CONTEXT_REF.test(value)) {
        throw directiveError(`Unsupported v1 context reference: ${value}`);
      }
      if (name === "workstream" && !value.startsWith("ws_")) {
        throw directiveError(`${match[1]}workstream must contain a durable ws_ id`);
      }
      const assignUnique = (key) => {
        if (config[key] && config[key] !== value) {
          throw directiveError(`Conflicting ${match[1]}${name} directives in ${sourceName}`);
        }
        config[key] = value;
      };
      if (name === "agent") assignUnique("agent");
      else if (name === "session") assignUnique("session");
      else if (name === "workstream") assignUnique("workstreamId");
      else if (name === "ctx") config.context.push(value);
      else config.skills.push(value);
      sawDirective = true;
      bodyStart = index + 1;
      continue;
    }
    if (/^@@[A-Za-z]/.test(line) || (allowLegacySingleAt && /^@[A-Za-z]/.test(line))) {
      throw directiveError(`Malformed or unsupported ${sourceName} directive: ${line.trim()}`);
    }
    if (sawDirective && line.trim() === "") {
      bodyStart = index + 1;
      continue;
    }
    bodyStart = index;
    break;
  }

  const prompt = lines.slice(bodyStart).join("\n").trim();
  if (!prompt) throw directiveError(`${sourceName} needs non-empty body text`);
  return { ...config, prompt };
}
