export function createSessionApiHandlers({
  readRecentNotes,
  touchRecentNote,
  readCursorPositions,
  touchCursorPosition,
  closeEditorClient,
  cancelExternalProseChecksForClient,
}) {
  return {
    "aaronnote:api:session:recent": async () => ({ type: "recent", recent: await readRecentNotes() }),
    "aaronnote:api:session:touch-recent": async (file, openedAt) => ({
      type: "recent",
      recent: await touchRecentNote(String(file || ""), Number(openedAt) || Date.now()),
    }),
    "aaronnote:api:session:positions": async () => ({ type: "positions", positions: await readCursorPositions() }),
    "aaronnote:api:session:save-position": async (position) => ({
      type: "positions",
      positions: await touchCursorPosition(position || {}),
    }),
    "aaronnote:api:session:client-close": async (body) => {
      cancelExternalProseChecksForClient(body?.clientId || body?.client);
      return closeEditorClient(body || {});
    },
  };
}
