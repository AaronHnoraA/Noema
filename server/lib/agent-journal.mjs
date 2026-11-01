// Durable facts under a Project's `.agent/`: an append-only journal, a lock and
// atomic writes, shared by the task graph and Pi's watches.  Node built-ins only.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_WAIT_MS = 5_000;

const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Every readable event of FILE, and how many lines could not be read. */
export async function readJournal(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], torn: 0 };
    throw error;
  }
  const events = [];
  let torn = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { torn += 1; }
  }
  return { events, torn };
}

/** Append one event durably.  A crash can only leave a torn last line, which
 * readers skip; the next append starts on a line of its own. */
export async function appendEvent(file, event) {
  let separator = "";
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      if (size) {
        const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
        if (buffer[0] !== 10) separator = "\n";
      }
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const handle = await open(file, "a");
  try {
    await handle.appendFile(`${separator}${JSON.stringify(event)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** Serialize writers of DIRECTORY across processes.  A lock is broken only when
 * its owner is provably dead; a slow writer is waited for and then reported,
 * never overwritten, however long it takes.  NAME says what is held. */
export async function withLock(directory, name, work) {
  const lock = join(directory, ".lock");
  const started = Date.now();
  for (;;) {
    try {
      await writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = await readFile(lock, "utf8").then(JSON.parse).catch(() => null);
      if (holder && !ownerAlive(holder.pid)) { await rm(lock, { force: true }); continue; }
      if (Date.now() - started > LOCK_WAIT_MS) fail(`Another writer holds ${name}; retry`, 423);
      await sleep(25);
    }
  }
  try { return await work(); } finally { await rm(lock, { force: true }); }
}

/** Make `.agent/NAME` under ROOT.  `.agent/` is never tracked; a repository with
 * no kernel store has no ignore yet. */
export async function ensureAgentDirectory(root, name) {
  await mkdir(join(root, ".agent", name), { recursive: true });
  await writeFile(join(root, ".agent", ".gitignore"), "*\n", { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

export async function atomicWrite(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, file);
}
