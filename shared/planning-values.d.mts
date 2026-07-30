export type Repeater = { mode: "+" | "++" | ".+"; n: number; unit: "d" | "w" | "m" | "y" };
export type ParsedDate = { time: number; hasTime: boolean };
export type DepRef = { id: string | null; noteTitle: string | null; text: string; raw: string };

export const TODO_STATUSES: Set<string>;
export const DATE_KEYS: Set<string>;
export const TODO_KEY_ALIASES: Record<string, string[]>;
export const TODO_CANON_KEYS: string[];

export function canonicalTodoArgs(args: Record<string, unknown>): Record<string, string>;
export function todoArgKeyForCanonical(canonKey: string, existingArgs?: Record<string, unknown>): string;

export function midnightMs(d: Date): number;
export function parseDateValue(raw: string): ParsedDate | null;
export function formatDateValue(time: number, hasTime: boolean): string;
export function normalizeDateValue(raw: string): string | null;

export function normalizeTodoStatus(raw?: string): string;

export function shiftDate(time: number, n: number, unit: "d" | "w" | "m" | "y"): number;
export function parseRepeater(raw: string): Repeater | null;
export function applyRepeater(dateStr: string, repeater: Repeater | null, todayMs?: number): string;

export function parseLeadTime(raw: string, fallbackDays?: number): number;

export function parseDepRefs(raw: string): DepRef[];

export function parseDuration(raw: string): number | null;
export function formatDuration(totalMinutes: number): string;
