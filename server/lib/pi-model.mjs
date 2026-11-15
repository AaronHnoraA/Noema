// One bounded model call through the pinned Pi runtime and the Codex login
// Noema's Pi already uses: no second token, no OpenAI Platform key.  Shared by
// the Hy Memory gateway (scripts/noema-pi-memory-gateway.mjs) and the
// exploration's duplicate check (server/lib/exploration.mjs).
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PI_MODEL = "gpt-5.6-luna";

export const piAgentDir = () => process.env.NOEMA_PI_AGENT_DIR
  || path.resolve(import.meta.dirname, "../../../../var/noema/pi");

/** The installed Pi coding-agent package, or throws when it is missing. */
export function piPackage() {
  const override = process.env.NOEMA_PI_CODING_AGENT_PACKAGE;
  if (override) return override;
  const candidate = path.resolve(import.meta.dirname,
    "../../../../var/agent/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  if (existsSync(candidate)) return candidate;
  throw new Error("Noema Pi runtime is unavailable");
}

/** A Pi model runtime for MODEL_ID; throws when Pi or its login is not configured. */
export async function createPiModel({ modelId = DEFAULT_PI_MODEL, agentDir = piAgentDir() } = {}) {
  const { ModelRuntime } = await import(pathToFileURL(piPackage()).href);
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const model = runtime.getModel("openai-codex", modelId);
  if (!model || !runtime.hasConfiguredAuth("openai-codex")) throw new Error(`Noema Pi ${modelId} is not configured`);
  return { modelId, complete: (context, options) => runtime.completeSimple(model, context, options) };
}

let shared = null;
const SYSTEM_CA = "/etc/ssl/cert.pem";

/** Node reads NODE_EXTRA_CA_CERTS only at startup, so a process without it
 * (the host, when Emacs did not set it) makes the call in a child that has it,
 * as the Hy Memory bridge does. */
const needsChild = () => !process.env.NODE_EXTRA_CA_CERTS && existsSync(SYSTEM_CA) && !process.env.NOEMA_PI_MODEL_CHILD;

function callInChild(request, timeoutMs) {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [import.meta.filename], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, NODE_EXTRA_CA_CERTS: SYSTEM_CA, NOEMA_PI_MODEL_CHILD: "1" },
    });
    let output = "";
    const limit = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 10_000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { clearTimeout(limit); failed(error); });
    child.on("close", (code) => {
      clearTimeout(limit);
      try {
        const answer = JSON.parse(output);
        if (code === 0 && answer.ok) done(answer.arguments); else failed(new Error(answer.message || "The model call failed"));
      } catch { failed(new Error("The model call failed")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/**
 * Ask for exactly one call of TOOL: `{system, user, tool:{name, description,
 * parameters}}` → the call's arguments.  Throws on anything else, so a caller
 * never mistakes a missing answer for an answer.
 */
export async function callOneTool({ system, user, tool, timeoutMs = 60_000 }) {
  if (needsChild()) return callInChild({ system, user, tool, timeoutMs }, timeoutMs);
  shared ??= createPiModel().catch((error) => { shared = null; throw error; });
  const model = await shared;
  const result = await model.complete({
    systemPrompt: system,
    messages: [{ role: "user", content: user, timestamp: Date.now() }],
    tools: [tool],
  }, { reasoning: "off", toolChoice: "auto", timeoutMs, transport: "sse" });
  if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error("The model call failed");
  const calls = result.content.filter((part) => part.type === "toolCall" && part.name === tool.name);
  if (calls.length !== 1) throw new Error(`The model did not answer with one ${tool.name} call`);
  return calls[0].arguments ?? {};
}

// As a child of `callInChild`: one request on stdin, one answer on stdout, and
// never a provider message or prompt text on stderr.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    process.stdout.write(JSON.stringify({ ok: true, arguments: await callOneTool(JSON.parse(input)) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
    process.exitCode = 1;
  }
}
