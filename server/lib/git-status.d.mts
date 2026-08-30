export type GitStatusEntry = {
  code: string;
  path: string;
  origPath: string;
  label: string;
  conflicted: boolean;
  untracked: boolean;
  staged: boolean;
  unstaged: boolean;
};
export type GitPorcelainStatus = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  detached: boolean;
  initial: boolean;
  gone: boolean;
  entries: GitStatusEntry[];
  changedFiles: number;
  conflictedFiles: number;
  clean: boolean;
  display: string;
};
export function parseGitPorcelainStatus(text: string, options?: { nul?: boolean }): GitPorcelainStatus;
