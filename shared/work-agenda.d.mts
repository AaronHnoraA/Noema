import type { ResearchNotebook } from "../server/lib/research-notebook.mjs";

export type WorkAgendaKey = "sche" | "ddl" | "end" | "prio" | "effort" | "tags" | "context" | "project" | "status" | "done" | "progress" | "clocks";
export type WorkAgendaClock = { id: string; from: string; to?: string };
export type WorkAgenda = Partial<Record<Exclude<WorkAgendaKey, "clocks">, string>> & { clocks?: WorkAgendaClock[] };
export type WorkAgendaStatus = "todo" | "doing" | "blocked" | "done" | "cancelled";
export type WorkAgendaPatch = Partial<Record<Exclude<WorkAgendaKey, "clocks" | "progress">, string | null>> & {
  title?: string;
  progress?: string | number | null; clocks?: WorkAgendaClock[] | null;
  op?: "patch" | "complete" | "clock-in" | "clock-out"; clockId?: string; at?: string;
};
export const WORK_AGENDA_KEYS: readonly WorkAgendaKey[];
export const WORK_AGENDA_STATUSES: readonly WorkAgendaStatus[];
export function validateWorkClocks(clocks: unknown): string[];
export function validateWorkAgenda(agenda: unknown, kind: string): string[];
export function parseWorkAgendaCommand(lines: string[], start: number, options?: { kind?: string; sourceName?: string }): {
  type: "todo"; agenda: WorkAgenda; title: string; end: number;
} | { type: "clock"; clock: WorkAgendaClock; title: string; end: number };
export function extractWorkAgendaDirective(source: string, options?: { kind?: string; sourceName?: string }): WorkAgenda | null;
export function formatWorkAgendaDirective(agenda: WorkAgenda, options?: { kind?: string; title?: string; sourceName?: string }): string;
export function replaceWorkAgendaDirective(source: string, agenda: WorkAgenda | null, options?: { kind?: string; title?: string; sourceName?: string }): string;
export type WorkAgendaTodo = {
  id: string;
  workNodeId: string;
  notebookId: string;
  sourceKind: "work-node";
  state: string | null;
  outcome: string | null;
  status: WorkAgendaStatus;
  declaredStatus: WorkAgendaStatus;
  nativeBlockedBy: string[];
  nativeDepends: string[];
  text: string;
  noteTitle: string;
  file: string;
  path: string;
  index: number;
  line: number;
  source: string;
  updatedAt: number | undefined;
  canon: Record<string, string>;
  tags: string[];
  cellIds: string[];
  availableActions: string[];
};
export type WorkAgendaDagNode = {
  id: string; workNodeId: string; notebookId: string; sourceKind: "work-node"; nodeKind: string;
  title: string; text: string; file: string; path: string; index: number; line: number; cellIds: string[];
  status: WorkAgendaStatus; declaredStatus: WorkAgendaStatus; state: string | null; outcome: string | null; hasAgenda: boolean;
};
export type WorkAgendaDagEdge = { id: string; from: string; to: string; type: "depends" | "lineage" };
export function workAgendaPlanning(notebook: ResearchNotebook, source: { file: string; root?: string; mtimeMs?: number }): {
  todos: WorkAgendaTodo[]; projects: never[]; milestones: never[];
  clocks: Array<{ id: string; nativeTodoId: string; workNodeId: string; clockId: string;
    sourceKind: "work-node"; file: string; index: number; source: string; args: { from: string; to?: string } }>;
  dag: { nodes: WorkAgendaDagNode[]; edges: WorkAgendaDagEdge[] };

};
