export type ParsedBlockAnchor = { blockId: string; attrs: Record<string, string> };
export type ParsedOrgEnvIdentityTitle = ParsedBlockAnchor & { title: string };

export const BLOCK_ID_SOURCE: string;
export const UUID_V7_BLOCK_ID_SOURCE: string;
export const LEGACY_SIYUAN_BLOCK_ID_SOURCE: string;
export const BLOCK_REFERENCE_ID_SOURCE: string;
export const BLOCK_ANCHOR_SOURCE: string;
export function orgEnvSupportsBlockIdentity(kind: string): boolean;
export function parseBlockProperties(raw?: string): Record<string, string>;
export function parseBlockAnchor(value?: string): ParsedBlockAnchor;
export function parseOrgEnvIdentityTitle(kind: string, value: string): ParsedOrgEnvIdentityTitle;
export function isBlockReferenceId(value: string): boolean;
export function shortBlockId(value: string, length?: number): string;
