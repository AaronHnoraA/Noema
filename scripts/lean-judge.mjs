#!/usr/bin/env node
// Command line of the Lean judge: Lean, not a model, decides whether a proof
// proves the person's frozen statement.  Needs no Noema host; Pi reaches the
// same code through `noema:api:agent:lean:judge`.
// See docs/noema/design/math-exploration.md (L1-L8).
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { leanJudge } from "../server/lib/lean-judge.mjs";

const USAGE = `node scripts/lean-judge.mjs OP --statement FROZEN.lean [--candidate PROOF.lean] [--lake DIR] [--timeoutMs N]

statement  is FROZEN a statement proofs can be judged against? (no Lean run)
check      grade a partial proof: invalid | errors | sorries | complete
verify     decide a solve: the statement and preamble kept, Lean elaborates,
           axioms only propext/Classical.choice/Quot.sound, pp.all type equal
FROZEN is the person's file: definitions, then one \`theorem NAME … := sorry\`.
LAKE defaults to the nearest Lake project above FROZEN.  Exits 1 unless the
answer is ok, accepted or complete.`;

// Pristine types are cached under Emacs var/, one file per frozen text.
const CACHE = join(dirname(realpathSync(import.meta.filename)), "../../../var/noema/lean-judge");

export function parseFlags(argv) {
  const fields = {};
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word.startsWith("--")) throw new Error(`Unexpected argument: ${word}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${word} needs a value`);
    fields[word.slice(2)] = word === "--timeoutMs" ? Number(next) : next;
    index += 1;
  }
  for (const key of ["statement", "candidate", "lake"]) if (fields[key]) fields[key] = resolve(fields[key]);
  return fields;
}

export async function main(argv, options = {}) {
  const [op, ...rest] = argv;
  if (!op || op === "help") return { text: USAGE };
  return { json: await leanJudge({ ...parseFlags(rest), op }, { cache: CACHE, ...options }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { text, json } = await main(process.argv.slice(2));
    process.stdout.write(text !== undefined ? `${text}\n` : `${JSON.stringify(json, null, 2)}\n`);
    if (json && !(json.ok === true || json.accepted === true || json.status === "complete")) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exitCode = 2; }
}
