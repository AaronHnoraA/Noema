export function moveWindowsPathToRecycleBin(
  file: string,
  options?: {
    kind?: "file" | "directory";
    run?: (command: string, args: string[], options: { windowsHide: boolean }) => Promise<unknown>;
  },
): Promise<string>;

export function createWindowsZip(
  sourceDirectory: string,
  outputFile: string,
  options?: {
    run?: (command: string, args: string[], options: { windowsHide: boolean }) => Promise<unknown>;
  },
): Promise<string>;
