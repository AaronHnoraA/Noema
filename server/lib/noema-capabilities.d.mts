export type CapabilitySource = {
  scope: string;
  scopeId: string;
  path: string;
  index?: number;
};

export type CapabilityDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  id?: string;
  type?: "skill" | "mcp";
};

export type ResolvedCapability = {
  id: string;
  type: "skill" | "mcp";
  title: string;
  description: string;
  enabled: boolean;
  selectable: boolean;
  source: CapabilitySource | null;
  effective: Record<string, any>;
  patches: Array<{ scope: string; scopeId: string; source: string; file?: string; patch: Record<string, any> }>;
  selectedBy: Array<{ scope: string; scopeId: string; enabled: boolean; reason: string }>;
  shadowedDefinitions: CapabilitySource[];
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  diagnostics: CapabilityDiagnostic[];
  runtime?: {
    state: string;
    availability: "available" | "unavailable" | "unknown";
    running: boolean | null;
    connected: boolean | null;
    observed: boolean;
  };
};

export type CapabilityEnvironment = {
  schema: "noema.capability-resolution/1";
  scope: "global" | "project";
  projectRoot: string | null;
  configFile: string;
  scopes: Array<{ name: string; id: string; rank: number; source: string; skillDirectories?: string[] }>;
  libraries?: Array<{ id: string; scope: string; format: string; configFile: string; skillDirectories: string[]; state: string; count: number }>;
  skills: ResolvedCapability[];
  mcps: ResolvedCapability[];
  active: { skills: string[]; mcps: string[] };
  diagnostics: CapabilityDiagnostic[];
};

export const NOEMA_CAPABILITY_SCHEMA: "noema.capabilities/1";
export const NOEMA_CAPABILITY_FILE: "noema-capabilities.json";

export function resolveProjectCapabilities(options: {
  root?: string | null;
  scope?: "global" | "project";
  requestedSkills?: string[];
  runtimeDescriptor?: Record<string, any>;
  environment?: Record<string, string | undefined>;
  userHome?: string;
  builtinSkillDirectory?: string;
  globalConfigPath?: string;
  globalSkillDirectory?: string;
  includeContent?: boolean;
}): Promise<CapabilityEnvironment>;

export function assertRunnableCapabilities(environment: CapabilityEnvironment): CapabilityEnvironment;
export function resolvedSkillsForRun(environment: CapabilityEnvironment): {
  skills: Record<string, any>[];
  items: Record<string, any>[];
};
export function resolvedMCPServersForRun(environment: CapabilityEnvironment): Record<string, any>[];

export function mutateProjectCapability(options: {
  root?: string | null;
  scope?: "global" | "project";
  globalConfigPath?: string;
  environment?: Record<string, string | undefined>;
  userHome?: string;
  type: "skill" | "mcp";
  id: string;
  enabled?: boolean;
  patch?: Record<string, any> | null;
  definition?: Record<string, any>;
}): Promise<Record<string, any>>;

export function projectCapabilityConfig(root?: string | null, options?: {
  scope?: "global" | "project"; globalConfigPath?: string;
  environment?: Record<string, string | undefined>; userHome?: string;
}): Promise<Record<string, any>>;
export function installProjectSkill(options: {
  root?: string | null; scope?: "global" | "project";
  globalConfigPath?: string; globalSkillDirectory?: string;
  environment?: Record<string, string | undefined>; userHome?: string;
  id?: string; description?: string; sourceDirectory?: string;
}): Promise<{ id: string; path: string }>;

export function prepareProjectSkill(options: {
  root: string; id: string; operation: "copy" | "patch";
  globalConfigPath?: string; globalSkillDirectory?: string; builtinSkillDirectory?: string;
  environment?: Record<string, string | undefined>; userHome?: string;
}): Promise<{ id: string; path: string; directory: string; operation: string }>;
