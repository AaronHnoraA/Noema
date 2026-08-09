export type ParsedOrgEnvIdentityTitle = { title: string; blockId: string };

export const BLOCK_ID_SOURCE: string;
export function orgEnvSupportsBlockIdentity(kind: string): boolean;
export function parseOrgEnvIdentityTitle(kind: string, value: string): ParsedOrgEnvIdentityTitle;
export function shortBlockId(value: string, length?: number): string;
