export type PlanningNode = {
  kind: string;
  status?: string;
  title: string;
  attrs: Record<string, string>;
  attrsRaw?: string;
  shape: "inline" | "block";
  span: { from: number; to: number; line: number; column: number };
  raw: string;
  diagnostics: Array<{ kind?: string; message?: string }>;
};

export const PLANNING_KINDS: Set<string>;
export function scanPlanningNodes(input: string, options?: { kind?: string }): PlanningNode[];
export function serializePlanningValue(value: unknown): string;
export function serializeInlineAttrs(attrs: Record<string, unknown>): string;
export function serializeBlockAttrs(attrs: Record<string, unknown>): string;
export function patchPlanningNodeRaw(node: PlanningNode, patch?: { status?: string; attrs?: Record<string, unknown> }): string;
