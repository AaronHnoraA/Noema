export interface PlanningSourceSelector {
  kind?: string;
  index?: number;
  source?: string;
  id?: string;
  title?: string;
  open?: boolean;
}

export interface PlanningSourceMutation {
  type: "append" | "replace" | "insert-after";
  source?: string;
  initialContent?: string;
}

export interface PlanningSourceResult {
  content: string;
  from: number;
  to: number;
  source: string;
  nextSource: string;
}

export function applyPlanningSourceMutation(
  input: string,
  selector: PlanningSourceSelector,
  mutation: PlanningSourceMutation,
): PlanningSourceResult | null;
