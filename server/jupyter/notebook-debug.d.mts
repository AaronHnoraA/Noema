export interface DebugCell { id: string; code: string; line: number; path?: string; endLine?: number }
export function supportsNotebookDebug(info: any): boolean;
export function debugRequest(kernel: any, content: any, timeoutMs?: number): Promise<any>;
export class NotebookDebugSources {
  constructor(file: string, cells: DebugCell[], activeId: string);
  cells: DebugCell[];
  references: Map<number, any>;
  source(source: any): any;
  location(value: any): any;
  response(command: string, body: any): any;
  incomingSource(source: any): any;
}
export function createNotebookDebugAdapter(options: {
  kernel: any; info: any; sourceFile: string; cells: DebugCell[]; cellId: string;
  runByLine?: boolean; execute: () => Promise<any>; interrupt?: () => Promise<any>;
  onClose?: () => void; timeoutMs?: number; connectTimeoutMs?: number;
}): Promise<{ host: string; port: number; sourceFile: string; cellId: string;
  close(): Promise<void>; sources: NotebookDebugSources }>;
