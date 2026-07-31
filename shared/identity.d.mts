export type NoemaIdKind = "repository" | "page" | "block";

export const NOEMA_ID_KINDS: readonly NoemaIdKind[];
export function normalizeNoemaIdKind(value: unknown): NoemaIdKind;
export function newNoemaId(kind: NoemaIdKind): string;
export function isUuidV7(value: unknown): boolean;
export function isPersistedNoemaId(value: unknown): boolean;
