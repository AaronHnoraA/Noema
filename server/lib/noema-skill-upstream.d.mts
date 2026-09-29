type GlobalOptions = {
  globalConfigPath?: string;
  globalSkillDirectory?: string;
  environment?: Record<string, string | undefined>;
  userHome?: string;
};

export type SkillLockEntry = {
  id: string;
  repository: string;
  ref?: string;
  commit: string;
  path: string;
  license?: string;
  skill_sha256?: string;
  tree_sha256?: string;
  helpers?: string;
  installed_at?: string;
  updated_at?: string;
  history?: Array<{ commit: string; skill_sha256?: string; replaced_at: string; discarded_local_edit?: boolean }>;
};

export const SKILL_LOCK_SCHEMA: "noema.skill-library-lock/1";
export function upstreamURL(repository: string): string;
export function skillLockPath(options?: GlobalOptions): string;
export function readSkillLock(options?: GlobalOptions): Promise<{ path: string; lock: { schema: string; skills: SkillLockEntry[] } }>;
export function skillTreeDigest(directory: string): Promise<string>;
export function skillUpstreamStatus(options?: GlobalOptions & { check?: boolean; ids?: string[] }): Promise<{
  lockFile: string;
  skillDirectory: string;
  checked: boolean;
  skills: Array<Record<string, any>>;
}>;
export function installUpstreamSkill(options: GlobalOptions & {
  repository: string; ref?: string; path?: string; commit?: string; license?: string;
}): Promise<{ id: string; path: string; entry: SkillLockEntry }>;
export function updateUpstreamSkill(options: GlobalOptions & {
  id: string; commit?: string; force?: boolean; dryRun?: boolean;
}): Promise<Record<string, any>>;
