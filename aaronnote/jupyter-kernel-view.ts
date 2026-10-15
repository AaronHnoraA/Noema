export type JupyterKernelView = {
  id?: string;
  status: string;
  stateLost?: boolean;
  lastError?: string;
};

export function jupyterKernelLabel(kernel: string, session: string, view: JupyterKernelView): string {
  const status = view.status || "unknown";
  if (status === "no-kernel") return "No kernel selected";
  const label = status === "error" ? "last run error"
    : status === "disconnected" ? "connection lost · state unknown"
      : status === "unavailable" ? "status unavailable · state unknown"
      : status === "dead" ? "kernel dead · state lost"
        : status;
  const lost = view.stateLost && !["dead", "disconnected", "unavailable"].includes(status)
    ? " · state lost" : "";
  return `${kernel} · ${session} · ${label}${lost}`;
}
