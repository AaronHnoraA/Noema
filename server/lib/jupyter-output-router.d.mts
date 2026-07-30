// Ambient types for the Output-widget router so TypeScript callers (tests,
// tooling) can import it. The implementation lives in jupyter-output-router.mjs.

export interface JupyterOutput {
  output_type: string;
  [key: string]: unknown;
}

export interface OutputWidgetRouter {
  /** Feed every widget comm message (comm_open/comm_msg/comm_close) here. */
  track(message: unknown): void;
  /** The Output-widget comm that should receive output with this parent msg_id, if any. */
  targetCommFor(parentId?: string): string | undefined;
  /** Append (with stream concatenation) an output to a widget's group. */
  pushOutput(commId: string, output: JupyterOutput): void;
  /** Clear a widget's group, or defer the clear until the next appended output. */
  clearOutput(commId: string, wait: boolean): void;
  /** Captured outputs grouped by Output-widget comm id. */
  readonly widgetOutputs: Record<string, JupyterOutput[]>;
  hasOutputs(): boolean;
}

export function createOutputWidgetRouter(): OutputWidgetRouter;
