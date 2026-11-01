#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { callAgentApi } from "../server/lib/agent-api-client.mjs";

export async function main(argv, invoke = callAgentApi, input = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}) {
  const [command, name = "", payload] = argv;
  if (command === "discover") return invoke("noema:api:agent:discover", [{ query: name, ...(payload ? JSON.parse(payload) : {}) }]);
  if (command === "describe") return invoke("noema:api:agent:describe", [{ channel: name }]);
  if (command === "call") {
    if (payload !== undefined && payload !== "-") throw new Error("Pass JSON args through stdin (call CHANNEL -), keeping source text out of shell interpolation");
    return invoke(name, JSON.parse(await input()));
  }
  if (command === "help" || !command) return { usage: ["node scripts/agent-api.mjs discover [words] [pagination JSON]",
    "node scripts/agent-api.mjs describe CHANNEL", "node scripts/agent-api.mjs call CHANNEL - < args.json"],
    workflow: "Discover names, describe one operation, then call it. For Markdown read agent:document:read, then agent:document:propose; the person reviews in Noema. All arguments are a positional JSON array." };
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result?.ok === false) process.exitCode = 1;
  } catch (error) { process.stderr.write(String(error.message || error) + "\n"); process.exitCode = 1; }
}
