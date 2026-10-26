/** Check a file event against the version the editor has after its own save settles. */
export async function diskVersionChangedAfterSave(
  file: string,
  current: () => { file: string; version: string },
  whenSaveIdle: () => Promise<void>,
  readDiskVersion: (file: string) => Promise<string>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await whenSaveIdle();
    const before = current();
    if (before.file !== file) return false;
    const diskVersion = await readDiskVersion(file);
    await whenSaveIdle();
    const after = current();
    if (after.file !== file) return false;
    // Another local save completed during the disk read. Compare again with
    // a stable editor version rather than misclassifying that save as external.
    if (after.version !== before.version) continue;
    return !diskVersion || !after.version || diskVersion !== after.version;
  }
  // An active series of local saves will either settle or encounter a real
  // CAS conflict. A stale file event cannot establish an external change.
  return false;
}
