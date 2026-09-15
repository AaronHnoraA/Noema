export type ExternalCapabilitySource = {
  id: string;
  format: "claude" | "codex" | "opencode" | "pi";
  config?: string;
  skills?: string[];
};

export function validateExternalSources(sources: unknown): void;
export function loadExternalSource(
  source: ExternalCapabilitySource,
  base: string,
  environment: Record<string, string | undefined>,
): Promise<{
  id: string;
  name: string;
  format: string;
  path: string;
  directories: string[];
  state: "library" | "available" | "missing" | "error";
  errors: Map<string, string[]>;
  config: { skills: Record<string, unknown>; mcp: { servers: Record<string, any>[]; disabled: string[] } };
}>;
