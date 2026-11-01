export function parseFlags(argv: string[]): { fields: Record<string, string | true>; stdin: boolean };
export function main(argv: string[], input?: () => Promise<string>): Promise<{ text?: string; json?: any }>;
