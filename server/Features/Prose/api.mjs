export function createProseApiHandlers({
  runExternalProseChecks,
  acceptProseWord,
  setProseRuleDisabled,
  cancelExternalProseCheck,
  getLanguageToolSettings,
  languageToolSettingsRevision,
  languageToolSettingsDefaults,
  updateLanguageToolSettings,
  probeLanguageTool,
  broadcast,
}) {
  return {
    "noema:api:prose-check:run": (body) => runExternalProseChecks(body || {}),
    "noema:api:prose-check:accept-word": (word) => acceptProseWord(word),
    "noema:api:prose-check:disable-rule": (body) => setProseRuleDisabled(
      body?.rule ?? body,
      body?.disabled !== false,
    ),
    "noema:api:prose-check:cancel": (requestId) => cancelExternalProseCheck(requestId),
    "noema:api:prose-check:settings": async () => {
      const settings = await getLanguageToolSettings();
      return {
        ok: true,
        settings,
        revision: languageToolSettingsRevision(settings),
        defaults: languageToolSettingsDefaults(),
      };
    },
    "noema:api:prose-check:update-settings": async (body) => {
      const update = body && typeof body === "object" ? { ...body } : {};
      const expectedRevision = String(update.revision || "");
      delete update.revision;
      const settings = await updateLanguageToolSettings(update, { expectedRevision });
      const revision = languageToolSettingsRevision(settings);
      broadcast("command", { command: "languagetool-settings-changed", settings, settingsRevision: revision });
      return { ok: true, settings, revision, defaults: languageToolSettingsDefaults() };
    },
    "noema:api:prose-check:probe": (body) => probeLanguageTool(body || {}),
  };
}
