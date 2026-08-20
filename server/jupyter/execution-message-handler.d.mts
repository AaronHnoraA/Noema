import type { Kernel } from "@jupyterlab/services";

export function jupyterWidgetCommOpenP(content: unknown): boolean;

/** `execute_reply` payload from `%load`/`%recall`: rewrite this cell, or insert one below. */
export interface SetNextInputPayload {
  text: string;
  replace: boolean;
}

/** `execute_reply` payload from `exit`/`quit` typed in a cell. */
export interface AskExitPayload {
  keepKernel: boolean;
}

export function applyReplyPayloads(
  reply: unknown,
  pushOutput?: (output: Record<string, unknown>) => void,
): { setNextInput?: SetNextInputPayload; askExit?: AskExitPayload };

export interface ExecuteOnKernelResult {
  status: string;
  executionCount: number | null;
  outputs: Record<string, unknown>[];
  setNextInput?: SetNextInputPayload;
  askExit?: AskExitPayload;
  widgetMessages?: Record<string, unknown>[];
  widgetMessagesTruncated?: boolean;
  widgetOutputs?: Record<string, Record<string, unknown>[]>;
}

/**
 * A live patch against the outputs array being assembled. The resolved
 * `outputs` stays authoritative, so a consumer that drops events still
 * converges; these exist so a long-running cell shows progress.
 */
export type ExecutionEvent =
  | { kind: "status"; state: string }
  | { kind: "executionCount"; value: number | null }
  | { kind: "set"; index: number; output: Record<string, unknown> }
  | { kind: "append"; index: number; text: string }
  | { kind: "clear" };

export function executeOnKernel(
  kernel: Kernel.IKernelConnection,
  code: string,
  options?: {
    silent?: boolean;
    storeHistory?: boolean;
    stopOnError?: boolean;
    streamLimit?: number;
    widgetMessageLimit?: number;
    widgetMessageBytesLimit?: number;
    execTimeoutMs?: number;
    onEvent?: (event: ExecutionEvent) => void;
    /**
     * Answer a kernel `input_request`. Providing this is what sets
     * `allow_stdin`; rejecting sends EOF so a cancelled prompt raises
     * EOFError in the cell instead of blocking the kernel.
     */
    onStdin?: (request: { prompt: string; password: boolean }) => Promise<string> | string;
  },
): Promise<ExecuteOnKernelResult>;
