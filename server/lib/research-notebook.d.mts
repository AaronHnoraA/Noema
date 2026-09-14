export const RESEARCH_SCHEMA: "noema.work-document/2";
export const LEGACY_RESEARCH_SCHEMA: "noema.research-notebook/1";
export const RESEARCH_NAMESPACE: "noema_research";
export const GRAPH_KINDS: readonly ["question", "work", "checkpoint"];
export const RESEARCH_KINDS: readonly ["question", "work", "checkpoint", "result"];
export const WORK_STATES: readonly ["open", "active", "waiting", "done", "dropped"];
export const WORK_OUTCOMES: readonly ["supported", "refuted", "inconclusive", "dead_end", "superseded"];
export const RELATION_TYPES: readonly ["lineage", "depends"];
export const RESEARCH_SUFFIX: ".noema";
export const LEGACY_RESEARCH_SUFFIX: ".noema.ipynb";

export type ResearchNotebook = {
  cells: any[];
  metadata: Record<string, any>;
  nbformat: number;
  nbformat_minor: number;
  [key: string]: any;
};

export type ResearchCellSummary = {
  id: string;
  workNodeId: string | null;
  cellType: string;
  kind: string;
  title: string;
  label: string;
  state: string | null;
  outcome: string | null;
  droppedReason: string | null;
  lineage: string[];
  depends: string[];
  of: string | null;
  ordinal: number;
};

export type ResearchWorkNodeSummary = {
  id: string;
  kind: "question" | "work" | "checkpoint";
  title: string;
  label: string;
  state: string | null;
  outcome: string | null;
  droppedReason: string | null;
  disclosure: string | null;
  lineage: string[];
  depends: string[];
  cellIds: string[];
  primaryCellId: string | null;
  ordinal: number;
};

export type ResearchValidationEntry = { code: string; cellId: string | null; message: string };
export type ResearchValidation = {
  ok: boolean;
  errors: ResearchValidationEntry[];
  warnings: ResearchValidationEntry[];
};

export type ResearchGraphNode = {
  id: string;
  kind: string;
  title: string;
  state: string | null;
  outcome: string | null;
  ordinal: number;
  cellId: string | null;
  cellIds: string[];
  orphaned: boolean;
  focus: boolean;
  folded: { hidden: number; kinds: Record<string, number>; outcomes: Record<string, number> } | null;
};

export type ResearchGraphProjection = {
  notebookId: string;
  title: string;
  focus: string | null;
  folds: string[];
  nodes: ResearchGraphNode[];
  edges: { from: string; to: string; type: string }[];
  omitted: number;
};

export type ResearchIndexer = {
  index(args: { root: string; path: string; actor?: string; reason?: string }): Promise<any>;
  status(args: { root: string; path: string }): Promise<any>;
  events(args: { root: string; notebookId?: string; after?: number; limit?: number }): Promise<any[]>;
};

export type ResearchMutation = { notebook: ResearchNotebook; cell: ResearchCellSummary | null; workNode?: ResearchWorkNodeSummary | null };
export type ResearchGraphKind = "question" | "work" | "checkpoint";
export type ResearchCellCreateSpec = {
  id?: string;
  cellId?: string;
  kind?: string;
  title?: string;
  source?: string | string[];
  workNodeId?: string;
  work_node_id?: string;
  lineageParent?: string;
  after?: string;
  depends?: string[];
};

type ResearchServiceMethod = (body?: Record<string, any>) => Promise<any>;

export type ResearchNotebookService = {
  create: ResearchServiceMethod;
  snapshot: ResearchServiceMethod;
  sync: ResearchServiceMethod;
  save: ResearchServiceMethod;
  createCell: ResearchServiceMethod;
  updateCell: ResearchServiceMethod;
  deleteCell: ResearchServiceMethod;
  deleteWorkNode: ResearchServiceMethod;
  setRelation: ResearchServiceMethod;
  setState: ResearchServiceMethod;
  writeRunResult: ResearchServiceMethod;
  projection: ResearchServiceMethod;
  events: ResearchServiceMethod;
};

export function researchError(message: string, statusCode?: number, code?: string): Error & { statusCode: number; code: string };
export function isResearchDocumentPath(file: string): boolean;
export function researchMeta(cell: any): Record<string, any>;
export function researchDocumentMeta(notebook: ResearchNotebook): Record<string, any>;
export function researchWorkNodes(notebook: ResearchNotebook): any[];
export function researchDependencies(notebook: ResearchNotebook): any[];
export function researchWorkNodeId(notebook: ResearchNotebook, value: string): string | null;
export function researchWorkNodeForCell(notebook: ResearchNotebook, cellOrId: any): any | null;
export function researchWorkNodeSummary(notebook: ResearchNotebook, value: string): ResearchWorkNodeSummary;
export function researchCellKind(cell: any, notebook?: ResearchNotebook | null): string;
export function newResearchCellId(notebook: ResearchNotebook | null | undefined, prefix?: string): string;
export function newResearchWorkNodeId(notebook: ResearchNotebook): string;
export function researchCellSummary(cell: any, ordinal?: number, notebook?: ResearchNotebook | null): ResearchCellSummary;
export function createResearchNotebook(options?: { title?: string; kernel?: string; language?: string }): ResearchNotebook;
export function isResearchNotebook(notebook: unknown): boolean;
export function parseResearchNotebook(text: string): ResearchNotebook;
export function migrateLegacyResearchNotebook(notebook: ResearchNotebook): ResearchNotebook;
export function findDependsCycle(notebook: ResearchNotebook): string[] | null;
export function findDependencyCycle(notebook: ResearchNotebook, types?: string[]): string[] | null;
export function validateResearchNotebook(notebook: ResearchNotebook): ResearchValidation;
export function createResearchCell(
  notebook: ResearchNotebook,
  spec: ResearchCellCreateSpec & { kind: ResearchGraphKind },
): ResearchMutation & { cell: ResearchCellSummary; workNode: ResearchWorkNodeSummary };
export function createResearchCell(
  notebook: ResearchNotebook,
  spec?: ResearchCellCreateSpec,
): ResearchMutation & { cell: ResearchCellSummary; workNode: ResearchWorkNodeSummary | null };
export function updateResearchCell(
  notebook: ResearchNotebook,
  cellId: string,
  patch?: { title?: string; source?: string | string[]; kind?: string },
): ResearchMutation;
export function deleteResearchCell(notebook: ResearchNotebook, cellId: string): { notebook: ResearchNotebook; removed: string[]; orphanedWorkNodeIds: string[] };
export function deleteResearchWorkNode(notebook: ResearchNotebook, workNodeId: string, options?: { deleteBoundCells?: boolean }): { notebook: ResearchNotebook; removedWorkNodeId: string; removedCells: string[] };
export function setResearchRelation(notebook: ResearchNotebook, cellId: string, type: string, parents?: string[]): ResearchMutation;
export function setResearchState(
  notebook: ResearchNotebook,
  cellId: string,
  change?: { state?: string; outcome?: string | null; reason?: string },
): ResearchMutation;
export function upsertResearchRunResult(
  notebook: ResearchNotebook,
  result: { workId: string; runId: string; status: "completed" | "cancelled" | "failed" | "interrupted"; content?: string },
): ResearchMutation;
export function researchGraphProjection(
  notebook: ResearchNotebook,
  options?: { focus?: string | null; folds?: string[]; depth?: number },
): ResearchGraphProjection;
export function researchRevision(text: string): string;
export function assertResearchFile(file: string): string;
export function readResearchNotebookFile(file: string): Promise<{ file: string; text: string; revision: string; notebook: ResearchNotebook }>;
export function writeResearchNotebookFile(
  file: string,
  notebook: ResearchNotebook,
  options?: { expectedRevision?: string | null; create?: boolean },
): Promise<{ file: string; text: string; revision: string; validation: ResearchValidation }>;
export function findResearchRepositoryRoot(file: string): Promise<string | null>;
export function createResearchNotebookService(options?: {
  getIndexer?: () => ResearchIndexer | null;
  allowWrite?: boolean;
}): ResearchNotebookService;
