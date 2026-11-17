// Comment threads of notes (C70): the page's Google Docs-style comments.
// Threads are stored beside the note (server/lib/note-comments.mjs).  Every
// write tells open pages, and a question meant for a collaborator is handed to
// Emacs, which owns the agent sessions and puts the reply back in the thread.

import { assignThread, createThread, deleteComment, editMessage, listThreads, replyThread,
  setThreadStatus } from "../../lib/note-comments.mjs";

const bad = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const fileOf = (body) => {
  const file = body?.file;
  if (typeof file !== "string" || !file.startsWith("/")) bad("An absolute note file is required");
  return file;
};

export function createCommentApiHandlers({ changed = () => {}, ask = () => {}, collaborators = () => {} } = {}) {
  const written = (file, thread) => { changed(file); return { ok: true, thread }; };
  // A person's comment goes to the note's collaborator unless they said not to.
  const asked = (file, thread, body, text) => {
    // An @-mention names who answers (C71); otherwise Emacs picks the note's collaborator.
    if (body?.ask !== false && thread) ask({ file, id: thread.id, text, quote: thread.quote,
      ...(body.to && typeof body.to === "object" ? { to: { buffer: String(body.to.buffer || ""),
        nativeSessionId: String(body.to.nativeSessionId || "") } } : {}) });
  };
  return {
    "noema:api:comments:list": async (body) => ({ ok: true, threads: await listThreads(fileOf(body)) }),
    "noema:api:comments:create": async (body) => {
      const file = fileOf(body);
      const thread = await createThread({ ...body, file, author: body.author });
      asked(file, thread, body, body.text);
      return written(file, thread);
    },
    "noema:api:comments:reply": async (body) => {
      const file = fileOf(body);
      const thread = await replyThread({ ...body, file });
      if (body.author?.kind !== "agent") asked(file, thread, body, body.text);
      return written(file, thread);
    },
    "noema:api:comments:resolve": async (body) =>
      written(fileOf(body), await setThreadStatus({ ...body, file: fileOf(body), resolved: body.resolved !== false })),
    "noema:api:comments:edit": async (body) => written(fileOf(body), await editMessage({ ...body, file: fileOf(body) })),
    "noema:api:comments:delete": async (body) => written(fileOf(body), await deleteComment({ ...body, file: fileOf(body) })),
    "noema:api:comments:assign": async (body) => written(fileOf(body), await assignThread({ ...body, file: fileOf(body) })),
    // A note's collaborators changed (Emacs): pages refresh their header.
    "noema:api:comments:collaborators-changed": async (body) => { collaborators(fileOf(body)); return { ok: true }; },
    // Emacs appended to the journal itself: tell the pages.
    "noema:api:comments:changed": async (body) => { changed(fileOf(body)); return { ok: true }; },
  };
}
