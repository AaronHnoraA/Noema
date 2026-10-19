#!/usr/bin/env node
// Short-lived, loopback-only Chat Completions adapter for Hy Memory.  The
// actual model call goes through the same Pi runtime and Codex login that
// Noema's project Pi uses; no OpenAI Platform key is involved.
import http from "node:http";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BODY = 128 * 1024;
const agentDir = process.env.NOEMA_PI_AGENT_DIR
  || path.resolve(import.meta.dirname, "../../../var/noema/pi");
const modelId = process.env.NOEMA_HY_MEMORY_PI_MODEL || "gpt-5.6-luna";
const parentPid = process.ppid;
// A caller timeout can kill Python before its finally block runs. Do not
// leave a model adapter listening after the memory request has gone away.
setInterval(() => {
  if (process.ppid !== parentPid) process.exit(0);
}, 1000).unref();

function piPackage() {
  const override = process.env.NOEMA_PI_CODING_AGENT_PACKAGE;
  if (override) return override;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const command = path.join(dir, "pi-acp");
    if (!existsSync(command)) continue;
    const acpRoot = path.dirname(path.dirname(realpathSync(command)));
    const candidate = path.join(acpRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Noema Pi runtime is unavailable");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
  return "";
}

function contextFromMessages(messages) {
  const system = [];
  const conversation = [];
  for (const message of messages || []) {
    const role = String(message?.role || "unknown");
    const content = contentText(message?.content);
    if (role === "system" || role === "developer") system.push(content);
    else if (content) conversation.push(`${role}: ${content}`);
  }
  return {
    systemPrompt: system.join("\n\n"),
    messages: [{ role: "user", content: conversation.join("\n\n"), timestamp: Date.now() }],
  };
}

function piTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.filter((item) => item?.type === "function" && item.function?.name)
    .map((item) => ({
      name: item.function.name,
      description: item.function.description || "",
      parameters: item.function.parameters || { type: "object", properties: {} },
    }));
}

function responseFromPi(result, model) {
  if (result.stopReason === "error" || result.stopReason === "aborted")
    throw new Error("Noema Pi model call failed");
  const text = result.content.filter((part) => part.type === "text")
    .map((part) => part.text).join("");
  const calls = result.content.filter((part) => part.type === "toolCall")
    .map((part) => ({ id: part.id, type: "function", function: {
      name: part.name, arguments: JSON.stringify(part.arguments || {}),
    } }));
  return {
    id: result.responseId || `noema-pi-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: {
      role: "assistant", content: text || null,
      ...(calls.length ? { tool_calls: calls } : {}),
    }, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: result.usage?.input || 0,
      completion_tokens: result.usage?.output || 0,
      total_tokens: result.usage?.totalTokens || 0,
    },
  };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function main() {
  const { ModelRuntime } = await import(pathToFileURL(piPackage()).href);
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const model = runtime.getModel("openai-codex", modelId);
  if (!model || !runtime.hasConfiguredAuth("openai-codex"))
    throw new Error("Noema Pi Codex Luna is not configured");
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions")
      return send(res, 404, { error: { message: "not found" } });
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY) throw new Error("request too large");
      }
      const input = JSON.parse(body);
      if (input.model && input.model !== modelId) throw new Error("wrong model");
      const context = contextFromMessages(input.messages);
      const tools = piTools(input.tools);
      if (tools?.length) context.tools = tools;
      const result = await runtime.completeSimple(model, context, {
        reasoning: "off", toolChoice: tools?.length ? "auto" : "none",
        timeoutMs: 120000, transport: "sse",
      });
      send(res, 200, responseFromPi(result, modelId));
    } catch {
      // Never copy a provider exception or conversation text to stdout/stderr.
      send(res, 502, { error: { message: "Noema Pi memory call failed" } });
    }
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
  });
}

main().catch(() => {
  process.stderr.write("Noema Pi memory gateway unavailable\n");
  process.exitCode = 1;
});
