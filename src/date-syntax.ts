/**
 * Date parsing / formatting for inline-todo args and agenda.
 *
 * Value grammar (parseDateValue/formatDateValue/normalizeDateValue/DATE_KEYS)
 * is the shared planning DSL value layer — see src/planning-values.ts and
 * docs/agenda.md — so the editor and the server validate dates identically.
 * This module keeps only the editor-local presentation helpers (relative
 * labels/classes, date-key display labels).
 */
import { DATE_KEYS, formatDateValue, normalizeDateValue, parseDateValue, type ParsedDate } from "./planning-values.ts";

export type { ParsedDate };
export { DATE_KEYS, formatDateValue, normalizeDateValue, parseDateValue };

function midnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function relativeDateClass(time: number): "overdue" | "today" | "soon" | "future" {
  if (!Number.isFinite(time)) return "future";
  const today = midnight(new Date());
  const dayDiff = Math.floor((time - today) / 86_400_000);
  if (dayDiff < 0) return "overdue";
  if (dayDiff === 0) return "today";
  if (dayDiff <= 7) return "soon";
  return "future";
}

export function relativeDateLabel(time: number): string {
  if (!Number.isFinite(time)) return "";
  const today = midnight(new Date());
  const dayDiff = Math.floor((time - today) / 86_400_000);
  if (dayDiff < 0) return `${-dayDiff}d ago`;
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff < 7) return `in ${dayDiff}d`;
  if (dayDiff < 30) return `in ${Math.ceil(dayDiff / 7)}w`;
  return "later";
}

export const DATE_KEY_LABELS: Record<string, string> = {
  ddl: "DDL",
  due: "due",
  deadline: "DDL",
  sche: "scheduled",
  scheduled: "scheduled",
  start: "start",
  done: "done",
  date: "on",
  when: "when",
};
