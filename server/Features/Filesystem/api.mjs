export function createFilesystemApiHandlers({
  renameManagedPath,
  moveManagedPath,
  duplicateManagedFile,
  trashManagedPath,
  updateCurrentNoteMeta,
}) {
  return {
    "aaronnote:api:fs:rename": (body) => renameManagedPath(body || {}),
    "aaronnote:api:fs:move": (body) => moveManagedPath(body || {}),
    "aaronnote:api:fs:duplicate": (body) => duplicateManagedFile(body || {}),
    "aaronnote:api:fs:trash": (body) => trashManagedPath(body || {}),
    "aaronnote:api:meta:add": (body) => updateCurrentNoteMeta(body || {}, "add"),
    "aaronnote:api:meta:remove": (body) => updateCurrentNoteMeta(body || {}, "remove"),
    "aaronnote:api:meta:tag": (body) => updateCurrentNoteMeta(body || {}, "tag"),
    "aaronnote:api:meta:hide-roam": (body) => updateCurrentNoteMeta(body || {}, "hide-roam"),
    "aaronnote:api:meta:activate-roam": (body) => updateCurrentNoteMeta(body || {}, "activate-roam"),
  };
}
