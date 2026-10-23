export function createSessionApiHandlers({
  readRecentNotes,
  touchRecentNote,
  readCursorPositions,
  touchCursorPosition,
  closeEditorClient,
  cancelExternalProseChecksForClient,
}) {
  return {
    "noema:api:session:recent": async () => ({ type: "recent", recent: await readRecentNotes() }),
    "noema:api:session:touch-recent": async (file, openedAt) => ({
      type: "recent",
      recent: await touchRecentNote(String(file || ""), Number(openedAt) || Date.now()),
    }),
    "noema:api:session:positions": async () => ({ type: "positions", positions: await readCursorPositions() }),
    "noema:api:session:save-position": async (position) => ({
      type: "positions",
      positions: await touchCursorPosition(position || {}),
    }),
    "noema:api:session:client-close": async (body) => {
      cancelExternalProseChecksForClient(body?.clientId || body?.client);
      return closeEditorClient(body || {});
    },
  };
}
