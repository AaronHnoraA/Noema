// Comment threads of notes (C70): the page's Google Docs-style comments.
// Threads are stored beside the note (server/lib/note-comments.mjs).  Every
// write tells open pages and Emacs, whose task panel collects the comments
// (C73); handing a comment to an agent happens there, never here.

import { assignThread, createThread, deleteComment, editMessage, listThreads, replyThread,
  setThreadStatus } from "../../lib/note-comments.mjs";

const bad = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const fileOf = (body) => {
  const file = body?.file;
  if (typeof file !== "string" || !file.startsWith("/")) bad("An absolute note file is required");
  return file;
};

export function createCommentApiHandlers({ changed = () => {} } = {}) {
  const written = (file, thread) => { changed(file); return { ok: true, thread }; };
  return {
    "noema:api:comments:list": async (body) => ({ ok: true, threads: await listThreads(fileOf(body)) }),
    "noema:api:comments:create": async (body) =>
      written(fileOf(body), await createThread({ ...body, file: fileOf(body), author: body.author })),
    "noema:api:comments:reply": async (body) => written(fileOf(body), await replyThread({ ...body, file: fileOf(body) })),
    "noema:api:comments:resolve": async (body) =>
      written(fileOf(body), await setThreadStatus({ ...body, file: fileOf(body), resolved: body.resolved !== false })),
    "noema:api:comments:edit": async (body) => written(fileOf(body), await editMessage({ ...body, file: fileOf(body) })),
    "noema:api:comments:delete": async (body) => written(fileOf(body), await deleteComment({ ...body, file: fileOf(body) })),
    "noema:api:comments:assign": async (body) => written(fileOf(body), await assignThread({ ...body, file: fileOf(body) })),
    // Emacs appended to the journal itself: tell the pages.
    "noema:api:comments:changed": async (body) => { changed(fileOf(body), { fromEmacs: true }); return { ok: true }; },
  };
}
