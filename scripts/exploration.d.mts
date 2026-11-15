export function parseFlags(argv: string[]): Record<string, any>;
export function bodyOf(op: string, fields: Record<string, any>, cwd?: string): { body: any; markdown: boolean };
export function main(argv: string[], call?: (channel: string, args: any[], options?: any) => Promise<any>): Promise<{ text?: string; json?: any }>;
