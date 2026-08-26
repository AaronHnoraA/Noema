export const ATTRIBUTE_VIEW_FIELD_TYPES: readonly string[];
export const ATTRIBUTE_VIEW_FILTER_OPERATORS: readonly string[];
export const ATTRIBUTE_VIEW_CALC_OPERATORS: readonly string[];

export type AttributeViewRequest = {
  title?: string;
  source?: string;
  items?: Array<Record<string, unknown>>;
  nowMs?: number;
};

export type AttributeViewResult = {
  title: string;
  source: string;
  columns: any[];
  rows: any[];
  total: number;
  diagnostics: Array<Record<string, unknown>>;
  calculations?: any[];
};

export function evaluateAttributeView(request?: AttributeViewRequest): AttributeViewResult;
