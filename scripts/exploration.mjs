#!/usr/bin/env node
// Command line of an exploration, for Agents with a shell.  Reads (board,
// status, list) fold the journal on disk here, so a sandboxed member reads the
// board without loopback access.  Every write goes to the Noema host
// (`noema:api:agent:exploration`): the host starts members through Emacs, keeps
// each running exploration's clock, and holds the one writer of its journal.
// See docs/noema/design/math-exploration.md (E16).
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { callAgentApi } from "../server/lib/agent-api-client.mjs";
import { explorationView } from "../server/lib/exploration.mjs";

const READS = new Set(["board", "status", "list"]);

const USAGE = `node scripts/exploration.mjs OP --root DIR [--id ID] [--member mN] [flags] [--text]

Starter:  start --title T (--note FILE.md | --problem TEXT) [--standard S] [--lean FROZEN.lean]
                [--members 4] [--minutes 120] [--agent ID] [--modelId M] [--effort E]
                --buffer YOUR_BUFFER --session YOUR_NATIVE_SESSION_ID
          status | board | list | verdict --member mN --accept|--reject [--reason R] [--finish]
          stop | resume [--minutes N]
Member:   board | register --text T | post --kind lemma|partial|counterexample|dead-end|note --text T
          abandon --reason R | submit --report R [--files a,b] [--proof Proof.lean]
--text prints the board as Markdown.  A refusal says why and what to do.`;

const BOOLEAN = new Set(["accept", "reject", "finish", "markdown"]);
const NUMBER = new Set(["members", "minutes"]);

export function parseFlags(argv) {
  const fields = {};
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word.startsWith("--")) throw new Error(`Unexpected argument: ${word}`);
    const key = word.slice(2);
    const next = argv[index + 1];
    if (BOOLEAN.has(key) || (key === "text" && (next === undefined || next.startsWith("--")))) { fields[key === "text" ? "markdown" : key] = true; continue; }
    if (next === undefined) throw new Error(`${word} needs a value`);
    fields[key] = NUMBER.has(key) ? Number(next) : next;
    index += 1;
  }
  return fields;
}

/** Fields to the API body: --accept/--reject become accept, --buffer/--session the coordinator. */
export function bodyOf(op, fields, cwd = process.cwd()) {
  const { accept, reject, buffer, session, markdown, ...rest } = fields;
  const body = { ...rest, op, root: resolve(String(fields.root || cwd)) };
  if (accept || reject) body.accept = Boolean(accept);
  if (buffer || session) body.coordinator = { buffer, nativeSessionId: session };
  // Paths are the caller's, relative to where it runs.
  for (const key of ["note", "lean", "proof"]) if (body[key]) body[key] = resolve(cwd, body[key]);
  if (body.files) body.files = String(body.files).split(",").map((file) => file.trim()).filter(Boolean).map((file) => resolve(cwd, file));
  return { body, markdown: Boolean(markdown) };
}

export async function main(argv, call = callAgentApi, read = explorationView) {
  const [op, ...rest] = argv;
  if (!op || op === "help") return { text: USAGE };
  const { body, markdown } = bodyOf(op, parseFlags(rest));
  if (READS.has(op)) {
    const result = await read(body);
    return markdown && result?.markdown ? { text: result.markdown } : { json: result };
  }
  // A submission may wait for Lean; the host bounds that run itself.
  const result = await call("noema:api:agent:exploration", [body], { timeoutMs: op === "submit" ? 35 * 60_000 : 120_000 });
  if (markdown && result?.markdown) return { text: result.markdown };
  return { json: result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { text, json } = await main(process.argv.slice(2));
    process.stdout.write(text !== undefined ? text.replace(/\n?$/, "\n") : `${JSON.stringify(json, null, 2)}\n`);
    if (json?.registered === false || json?.submitted === false) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; }
}
