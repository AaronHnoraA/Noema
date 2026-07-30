export function createAssetsApiHandlers({
  noteRoot,
  storeAsset,
  storeAssetFromPath,
  renderTikzAsset,
  scanUnusedAssets,
  trashUnusedAssets,
  readSystemClipboard,
}) {
  return {
    "aaronnote:api:assets:upload": (body) => storeAsset(body || {}),
    "aaronnote:api:assets:store-from-path": (body) => storeAssetFromPath(body || {}),
    "aaronnote:api:assets:render-tikz": (body) => renderTikzAsset(body || {}),
    "aaronnote:api:assets:scan-orphans": async () => ({
      type: "unused-assets",
      assets: await scanUnusedAssets(),
      root: noteRoot,
    }),
    "aaronnote:api:assets:trash-orphans": (files) => trashUnusedAssets({ files }),
    "aaronnote:api:clipboard:read": (body) => readSystemClipboard(body || {}),
  };
}
