#!/usr/bin/env node
// Command line of the Project task graph.  It needs no Noema host: Agents with
// a shell call this directly; Pi reaches the same code through
// `noema:api:agent:project:graph`.  See docs/noema/design/project-graph.md.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectGraph, renderGraph } from "../server/lib/project-graph.mjs";

const USAGE = `node scripts/project-graph.mjs OP [--root DIR] [--text] [- < args.json]

Read:   status  next  check  graph  timeline  show --id ID
Write:  plan (JSON {"tasks":[{id,title,after,related,agent,review,cycles,body}]},
        --dryRun to vet)  claim [--take]  release  submit --evidence E [--partial]
        review --verdict V [--self]  note [--kind decision|commit --refs SHA]
        state --state todo|blocked|dropped  maintain
Flags become fields (--id ID --agent NAME --session ID); "-" reads a JSON object
from stdin.  graph --text draws it; check exits 1 on errors.  A refusal says why
and what to do; findings carry their own fix.`;

export function parseFlags(argv) {
  const fields = {};
  let stdin = false;
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index];
    if (word === "-") { stdin = true; continue; }
    if (!word.startsWith("--")) throw new Error(`Unexpected argument: ${word}`);
    const key = word.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next === "-" || next.startsWith("--")) fields[key] = true;
    else { fields[key] = next; index += 1; }
  }
  return { fields, stdin };
}

export async function main(argv, input = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}) {
  const [op, ...rest] = argv;
  if (!op || op === "help") return { text: USAGE };
  const { fields, stdin } = parseFlags(rest);
  const body = { ...(stdin ? JSON.parse(await input()) : {}), ...fields, op,
    root: resolve(String(fields.root || process.cwd())) };
  const result = await projectGraph(body);
  // Only for `graph` is --text the drawing; everywhere else it is the record's text.
  return op === "graph" && fields.text ? { text: renderGraph(result) } : { json: result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { text, json } = await main(process.argv.slice(2));
    process.stdout.write(text !== undefined ? text.replace(/\n?$/, "\n") : JSON.stringify(json, null, 2) + "\n");
    // `check` is usable as a gate: errors make the command fail.
    if (json?.ok === false) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; }
}
