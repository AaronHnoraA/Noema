// Comment threads of notes, kept beside them (C70).
//
// Each folder holds one hidden `.noema-comments.jsonl`: an append-only journal
// of the comment threads of the notes in that folder.  Writers only append one
// line per event (the host for page actions, Emacs for agent replies), so two
// writers never lose each other's work; a thread is folded from its events on
// read.  The host caches each folder's fold, keyed by the journal's size and
// mtime, so listing a note's threads reads the file only after it changed.
//
//   {"v":1,"op":"thread","id","note","quote","author","text","at","assignee"?}
//   {"v":1,"op":"reply","id","mid","author","text","at"}
//   {"v":1,"op":"resolve"|"reopen","id","author","at"}
//   {"v":1,"op":"edit","id","mid"?,"text","at"}      mid absent: the first message
//   {"v":1,"op":"delete","id","mid"?,"at"}            mid absent: the whole thread
//   {"v":1,"op":"assign","id","assignee","at"}
//   {"v":1,"op":"move","id","note","at"}              the note was renamed

import { appendFile, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { COMMENT_ID_RE } from "../../shared/comment-anchors.mjs";

export const COMMENTS_FILE = ".noema-comments.jsonl";
const bad = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const cache = new Map(); // journal path -> { size, mtimeMs, threads: Map }

export const journalFor = (file) => join(dirname(file), COMMENTS_FILE);

function author(value, fallback = { name: "You", kind: "person" }) {
  if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name) return fallback;
  return { name: value.name, kind: value.kind === "agent" ? "agent" : "person",
    ...(typeof value.session === "string" ? { session: value.session } : {}) };
}

/** Fold journal TEXT into a Map of thread id -> thread. */
export function foldJournal(text) {
  const threads = new Map();
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const thread = threads.get(event.id);
    switch (event.op) {
      case "thread":
        if (!thread) threads.set(event.id, {
          id: event.id, note: event.note, quote: event.quote ?? "", status: "open",
          author: author(event.author), createdAt: event.at, assignee: event.assignee ?? null,
          messages: [{ mid: "m0", author: author(event.author), text: event.text ?? "", at: event.at }],
        });
        break;
      case "reply":
        if (thread) thread.messages.push({ mid: event.mid, author: author(event.author), text: event.text ?? "", at: event.at });
        break;
      case "resolve": if (thread) Object.assign(thread, { status: "resolved", resolvedAt: event.at, resolvedBy: author(event.author) }); break;
      case "reopen": if (thread) thread.status = "open"; break;
      case "edit": {
        const message = thread?.messages.find((m) => m.mid === (event.mid ?? "m0"));
        if (message) Object.assign(message, { text: event.text ?? "", edited: event.at });
        break;
      }
      case "delete":
        if (!thread) break;
        if (!event.mid || event.mid === "m0") threads.delete(event.id);
        else thread.messages = thread.messages.filter((m) => m.mid !== event.mid);
        break;
      case "assign": if (thread) thread.assignee = event.assignee ?? null; break;
      case "move": if (thread && typeof event.note === "string") thread.note = event.note; break;
    }
  }
  return threads;
}

async function folder(journal) {
  const info = await stat(journal).catch(() => null);
  if (!info) { cache.delete(journal); return new Map(); }
  const hit = cache.get(journal);
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.threads;
  const threads = foldJournal(await readFile(journal, "utf8"));
  cache.set(journal, { size: info.size, mtimeMs: info.mtimeMs, threads });
  return threads;
}

/** Return FILE's threads, oldest first; resolved ones too. */
export async function listThreads(file) {
  const note = basename(file);
  return [...(await folder(journalFor(file))).values()]
    .filter((thread) => thread.note === note)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function getThread(file, id) {
  return (await folder(journalFor(file))).get(id) ?? null;
}

async function append(file, event) {
  await appendFile(journalFor(file), JSON.stringify({ v: 1, ...event, at: event.at ?? new Date().toISOString() }) + "\n");
}

function text(value) {
  if (typeof value !== "string" || !value.trim()) bad("A comment needs text");
  return value;
}

async function existing(file, id) {
  const thread = await getThread(file, id);
  if (!thread) bad("No such comment thread");
  return thread;
}

export async function createThread({ file, id, quote, text: body, author: who, assignee }) {
  if (typeof file !== "string" || !file.startsWith("/")) bad("An absolute note file is required");
  if (!COMMENT_ID_RE.test(String(id))) bad("Invalid comment id");
  if (await getThread(file, id)) bad("That comment already exists");
  await append(file, { op: "thread", id, note: basename(file), quote: String(quote ?? ""), author: author(who),
    text: text(body), ...(assignee ? { assignee } : {}) });
  return getThread(file, id);
}

export async function replyThread({ file, id, text: body, author: who }) {
  await existing(file, id);
  await append(file, { op: "reply", id, mid: `m-${randomUUID().slice(0, 8)}`, author: author(who), text: text(body) });
  return getThread(file, id);
}

export async function setThreadStatus({ file, id, resolved, author: who }) {
  await existing(file, id);
  await append(file, { op: resolved ? "resolve" : "reopen", id, author: author(who) });
  return getThread(file, id);
}

export async function editMessage({ file, id, mid, text: body }) {
  await existing(file, id);
  await append(file, { op: "edit", id, ...(mid ? { mid } : {}), text: text(body) });
  return getThread(file, id);
}

export async function deleteComment({ file, id, mid }) {
  await existing(file, id);
  await append(file, { op: "delete", id, ...(mid ? { mid } : {}) });
  return getThread(file, id);
}

export async function assignThread({ file, id, assignee }) {
  await existing(file, id);
  await append(file, { op: "assign", id, assignee: assignee ?? null });
  return getThread(file, id);
}

/** Let FILE's threads follow it to TARGET: a rename appends move events; a move
 * to another folder carries each thread's events into that folder's journal and
 * deletes them from the old one.  Returns the number of threads moved. */
export async function moveThreads(file, target) {
  const threads = await listThreads(file);
  if (!threads.length) return 0;
  if (dirname(file) === dirname(target)) {
    for (const thread of threads) await append(file, { op: "move", id: thread.id, note: basename(target) });
    return threads.length;
  }
  const ids = new Set(threads.map((thread) => thread.id));
  const lines = (await readFile(journalFor(file), "utf8")).split("\n").filter((line) => {
    try { return ids.has(JSON.parse(line).id); } catch { return false; }
  }).map((line) => {
    const event = JSON.parse(line);
    return JSON.stringify(event.op === "thread" ? { ...event, note: basename(target) }
      : event.op === "move" ? { ...event, note: basename(target) } : event);
  });
  await appendFile(journalFor(target), lines.join("\n") + "\n");
  for (const id of ids) await append(file, { op: "delete", id });
  return threads.length;
}
