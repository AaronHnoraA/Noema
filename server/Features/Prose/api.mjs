export function createProseApiHandlers({
  runExternalProseChecks,
  acceptProseWord,
  cancelExternalProseCheck,
  getLanguageToolSettings,
  languageToolSettingsRevision,
  languageToolSettingsDefaults,
  updateLanguageToolSettings,
  probeLanguageTool,
  broadcast,
}) {
  return {
    "aaronnote:api:prose-check:run": (body) => runExternalProseChecks(body || {}),
    "aaronnote:api:prose-check:accept-word": (word) => acceptProseWord(word),
    "aaronnote:api:prose-check:cancel": (requestId) => cancelExternalProseCheck(requestId),
    "aaronnote:api:prose-check:settings": async () => {
      const settings = await getLanguageToolSettings();
      return {
        ok: true,
        settings,
        revision: languageToolSettingsRevision(settings),
        defaults: languageToolSettingsDefaults(),
      };
    },
    "aaronnote:api:prose-check:update-settings": async (body) => {
      const update = body && typeof body === "object" ? { ...body } : {};
      const expectedRevision = String(update.revision || "");
      delete update.revision;
      const settings = await updateLanguageToolSettings(update, { expectedRevision });
      const revision = languageToolSettingsRevision(settings);
      broadcast("command", { command: "languagetool-settings-changed", settings, settingsRevision: revision });
      return { ok: true, settings, revision, defaults: languageToolSettingsDefaults() };
    },
    "aaronnote:api:prose-check:probe": (body) => probeLanguageTool(body || {}),
  };
}
