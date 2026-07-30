export type InlineCommand = {
  name: string;
  switchValue: string;
  context: string;
  argsRaw: string;
  args: Record<string, string>;
  argsError?: string;
  fullFrom: number;
  fullTo: number;
  contextFrom: number;
  contextTo: number;
};

export type BlockCommand = { name: string; title: string; content: string };

export function parseCommandArgs(raw?: string): Record<string, string>;
export function findInlineCommandClose(text: string, open: number, closeChar: "]" | "}"): number;
export function scanInlineCommands(text: unknown, name?: string): InlineCommand[];
export function parseBlockCommandOpenLine(line: unknown): { name: string; title: string } | null;
export function isBlockCommandCloseLine(line: unknown, name: string): boolean;
export function parseBlockCommandText(text: unknown): BlockCommand | null;
