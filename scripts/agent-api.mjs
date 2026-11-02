#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { callAgentApi } from "../server/lib/agent-api-client.mjs";

const HELP = {
  usage: ["call CHANNEL - < args.json", "describe CHANNEL [{\"source\":true}]", "discover [words] [pagination JSON]"],
  guidance: "args is a JSON array, usually one object. Call directly when the arguments are known; describe a channel only when unsure, discover only when the name is unknown.",
  common: {
    "agent:document:propose": [{ file: "absolute path", edits: [{ from: { line: 1, column: 0 }, to: { line: 1, column: 5 }, oldText: "exact current text", newText: "text", title: "optional" }] }],
    "agent:document:read": [{ file: "absolute path", range: "optional {from,to}" }],
    "agent:project:status": [{ root: "absolute path" }],
    "agent:skill:list": [{ root: "optional absolute path" }],
    "agent:skill:read": [{ id: "Skill id", root: "optional absolute path" }],
    "emacs:open": [{ file: "absolute path", placement: "other" }],
  },
};

export async function main(argv, invoke = callAgentApi, input = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}) {
  const [command, name = "", payload] = argv;
  if (command === "discover") return invoke("noema:api:agent:discover", [{ query: name, ...(payload ? JSON.parse(payload) : {}) }]);
  if (command === "describe") return invoke("noema:api:agent:describe", [{ channel: name, ...(payload ? JSON.parse(payload) : {}) }]);
  if (command === "call") {
    if (payload !== undefined && payload !== "-") throw new Error("Pass JSON args through stdin (call CHANNEL -), keeping source text out of shell interpolation");
    const text = await input();
    return invoke(name, text.trim() ? JSON.parse(text) : []);
  }
  if (command === "help" || !command) return HELP;
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result?.ok === false) process.exitCode = 1;
  } catch (error) { process.stderr.write(String(error.message || error) + "\n"); process.exitCode = 1; }
}
