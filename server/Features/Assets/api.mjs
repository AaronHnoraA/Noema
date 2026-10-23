export function createAssetsApiHandlers({
  noteRoot,
  storeAsset,
  storeAssetFromPath,
  scanUnusedAssets,
  trashUnusedAssets,
  inspectAssets,
  renameAsset,
  searchAssetContent,
  startObsidianAnalysis,
  readObsidianTask,
  startObsidianImport,
  cancelObsidianTask,
  readSystemClipboard,
}) {
  return {
    "noema:api:assets:upload": (body) => storeAsset(body || {}),
    "noema:api:assets:store-from-path": (body) => storeAssetFromPath(body || {}),
    "noema:api:assets:scan-orphans": async () => ({
      type: "unused-assets",
      assets: await scanUnusedAssets(),
      root: noteRoot,
    }),
    "noema:api:assets:trash-orphans": (files) => trashUnusedAssets({ files }),
    "noema:api:assets:inspect": () => inspectAssets(),
    "noema:api:assets:rename": (body) => renameAsset(body || {}),
    "noema:api:assets:search-content": (body) => searchAssetContent(body || {}),
    "noema:api:imports:obsidian-analyze": (body) => startObsidianAnalysis(body || {}),
    "noema:api:imports:obsidian-task": (body) => readObsidianTask(body || {}),
    "noema:api:imports:obsidian-start": (body) => startObsidianImport(body || {}),
    "noema:api:imports:obsidian-cancel": (body) => cancelObsidianTask(body || {}),
    "noema:api:clipboard:read": (body) => readSystemClipboard(body || {}),
  };
}
