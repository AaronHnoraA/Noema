export type InputSourceSwitcher = {
  set(mode: string): { ok: true; available: boolean; command?: "normal" | "restore" };
  close(): void;
};
export function createInputSourceSwitcher(options?: {
  helper?: string;
  platform?: string;
  spawnImpl?: (...args: never[]) => unknown;
}): InputSourceSwitcher;
