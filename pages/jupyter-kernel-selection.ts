export function selectedKernelOptionValue(
  kernelId: unknown,
  kernelStatus: unknown,
): string {
  const id = String(kernelId ?? "").trim();
  if (id) return `connect:${id}`;
  return String(kernelStatus ?? "").trim() === "no-kernel" ? "none:" : "";
}
