export function createFilesystemApiHandlers({
  renameManagedPath,
  moveManagedPath,
  duplicateManagedFile,
  trashManagedPath,
  updateCurrentNoteMeta,
}) {
  return {
    "noema:api:fs:rename": (body) => renameManagedPath(body || {}),
    "noema:api:fs:move": (body) => moveManagedPath(body || {}),
    "noema:api:fs:duplicate": (body) => duplicateManagedFile(body || {}),
    "noema:api:fs:trash": (body) => trashManagedPath(body || {}),
    "noema:api:meta:add": (body) => updateCurrentNoteMeta(body || {}, "add"),
    "noema:api:meta:remove": (body) => updateCurrentNoteMeta(body || {}, "remove"),
    "noema:api:meta:tag": (body) => updateCurrentNoteMeta(body || {}, "tag"),
    "noema:api:meta:hide-roam": (body) => updateCurrentNoteMeta(body || {}, "hide-roam"),
    "noema:api:meta:activate-roam": (body) => updateCurrentNoteMeta(body || {}, "activate-roam"),
  };
}
