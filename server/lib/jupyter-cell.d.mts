// Minimal ambient types for the Node cell service so TypeScript callers (tests,
// tooling) can import it. The implementation lives in jupyter-cell.mjs.

export interface JupyterCellServiceOptions {
  runtimeRoot?: string;
  stateRoot?: string;
  noteRoot?: string;
  workspaceRoot?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  zmq?: unknown;
  publish?: (event: string, payload: Record<string, unknown>) => void;
  fileHost?: {
    readFile(file: string, encoding?: string): Promise<unknown>;
    writeFile(file: string, data: unknown, encoding?: string): Promise<unknown>;
    mkdir(file: string, options?: unknown): Promise<unknown>;
    rename(from: string, to: string): Promise<unknown>;
    rm(file: string, options?: unknown): Promise<unknown>;
    stat(file: string): Promise<{ size: number; mtimeMs: number }>;
  };
  kernelHost?: unknown;
  openFile?: (payload: {
    file: string;
    line: number;
    col: number;
    nonce: string;
  }) => Promise<unknown> | unknown;
}

export interface JupyterCellService {
  execute(body?: Record<string, unknown>): Promise<Record<string, any>>;
  kernels(body?: Record<string, unknown>): Promise<Record<string, any>>;
  documentSnapshot(body?: Record<string, unknown>): Promise<Record<string, any>>;
  documentMutate(body?: Record<string, unknown>): Promise<Record<string, any>>;
  documentExecute(body?: Record<string, unknown>): Promise<Record<string, any>>;
  managerSnapshot(): Promise<Record<string, any>>;
  scriptAction(body?: Record<string, unknown>): Promise<Record<string, any>>;
  sessionSelect(body?: Record<string, unknown>): Promise<Record<string, any>>;
  kernelControl(body?: Record<string, unknown>): Promise<Record<string, any>>;
  openBoard(): Promise<Record<string, any>>;
  openScript(body?: Record<string, unknown>): Promise<Record<string, any>>;
  readScriptCell(body?: Record<string, unknown>): Promise<Record<string, any>>;
  executeScriptCell(body?: Record<string, unknown>): Promise<Record<string, any>>;
  clearScriptCellOutput(body?: Record<string, unknown>): Promise<Record<string, any>>;
  deleteScriptCell(body?: Record<string, unknown>): Promise<Record<string, any>>;
  saveScriptCellOutputUi(body?: Record<string, unknown>): Promise<Record<string, any>>;
  clearAllOutputs(body?: Record<string, unknown>): Promise<Record<string, any>>;
  variables(body?: Record<string, unknown>): Promise<Record<string, any>>;
  complete(body?: Record<string, unknown>): Promise<Record<string, any>>;
  inspect(body?: Record<string, unknown>): Promise<Record<string, any>>;
  kernelStatus(body?: Record<string, unknown>): Promise<Record<string, any>>;
  restart(body?: Record<string, unknown>): Promise<Record<string, any>>;
  interrupt(body?: Record<string, unknown>): Promise<Record<string, any>>;
  shutdownKernel(body?: Record<string, unknown>): Promise<Record<string, any>>;
  resolveConnectionInfoById(id: string): Promise<unknown | undefined>;
  readNbextensionAsset(relativePath: string): Promise<{ data: Buffer; contentType: string } | undefined>;
  touchKernelById(id: string): Promise<boolean>;
  listTasks(): Promise<Record<string, any>>;
  cleanup(body?: Record<string, unknown>): Promise<Record<string, any>>;
  shutdown(): Promise<void>;
}

export function createJupyterCellService(options?: JupyterCellServiceOptions): JupyterCellService;
export function readPersistedScriptCell(body?: Record<string, unknown>): Promise<{
  ok: true;
  kernel: string;
  session: string;
  language: string;
  cellId: string;
  code: string;
  output: Record<string, any> | null;
  exists: boolean;
  mtimeMs: number;
  size: number;
}>;
export function durationFromEnv(name: string, fallback: number): number;
export function jupyterWidgetCommOpenP(content: Record<string, unknown>): boolean;
