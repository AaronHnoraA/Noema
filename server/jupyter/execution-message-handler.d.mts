import type { Kernel } from "@jupyterlab/services";

export function jupyterWidgetCommOpenP(content: unknown): boolean;

export interface ExecuteOnKernelResult {
  status: string;
  executionCount: number | null;
  outputs: Record<string, unknown>[];
  widgetMessages?: Record<string, unknown>[];
  widgetMessagesTruncated?: boolean;
  widgetOutputs?: Record<string, Record<string, unknown>[]>;
}

export function executeOnKernel(
  kernel: Kernel.IKernelConnection,
  code: string,
  options?: {
    silent?: boolean;
    storeHistory?: boolean;
    streamLimit?: number;
    widgetMessageLimit?: number;
    widgetMessageBytesLimit?: number;
    execTimeoutMs?: number;
  },
): Promise<ExecuteOnKernelResult>;
