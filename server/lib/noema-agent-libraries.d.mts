export const DEFAULT_LEDGER: string;
export function agentLibraries(options?: { apply?: boolean; ledgerFile?: string; [key: string]: any }): Promise<{
  applied: boolean; skills: string[]; problems: Array<{ id: string; reason: string }>;
  libraries: Array<{ id: string; directory: string; state: string; linked: string[]; created: string[]; updated: string[];
    removed: string[]; native: string[]; conflicts: Array<{ id: string; reason: string }> }>;
}>;
