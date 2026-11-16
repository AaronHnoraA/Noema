export function parseFlags(argv: string[]): Record<string, any>;
export function bodyOf(op: string, fields: Record<string, any>, cwd?: string): { body: any; markdown: boolean };
export function main(argv: string[], call?: (channel: string, args: any[], options?: any) => Promise<any>, read?: (body: any) => Promise<any>, through?: (op: string, body: any, options: any) => Promise<any>): Promise<{ text?: string; json?: any }>;
export function requestThroughDirectory(op: string, body: any, options: { timeoutMs: number; poll?: number }): Promise<any>;
