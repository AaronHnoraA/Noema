import type { Kernel } from "@jupyterlab/services";

export interface KernelCompletionItem {
  text: string;
  /** From `_jupyter_types_experimental`; empty when the kernel doesn't supply it. */
  type: string;
  signature: string;
}

export interface KernelCompletionResult {
  matches: string[];
  items: KernelCompletionItem[];
  /** Offsets into the submitted `code` describing the span the matches replace. */
  cursorStart: number;
  cursorEnd: number;
  complete: boolean;
  timedOut?: boolean;
}

export interface KernelInspectResult {
  found: boolean;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  timedOut?: boolean;
}

export interface KernelIsCompleteResult {
  status: "complete" | "incomplete" | "invalid" | "unknown" | string;
  indent: string;
  timedOut?: boolean;
}

export interface KernelHistoryEntry {
  session: number;
  lineNumber: number;
  source: string;
  output: string;
}

export function completeOnKernel(
  kernel: Kernel.IKernelConnection | undefined,
  options?: { code?: string; cursorPos?: number; timeoutMs?: number },
): Promise<KernelCompletionResult>;

export function inspectOnKernel(
  kernel: Kernel.IKernelConnection | undefined,
  options?: { code?: string; cursorPos?: number; detailLevel?: 0 | 1; timeoutMs?: number },
): Promise<KernelInspectResult>;

export function isCompleteOnKernel(
  kernel: Kernel.IKernelConnection | undefined,
  options?: { code?: string; timeoutMs?: number },
): Promise<KernelIsCompleteResult>;

export function historyOnKernel(
  kernel: Kernel.IKernelConnection | undefined,
  options?: { pattern?: string; count?: number; output?: boolean; timeoutMs?: number },
): Promise<{ history: KernelHistoryEntry[]; timedOut?: boolean }>;

export function commInfoOnKernel(
  kernel: Kernel.IKernelConnection | undefined,
  options?: { targetName?: string; timeoutMs?: number },
): Promise<{ comms: Record<string, { target_name?: string }>; timedOut?: boolean }>;
