export function mathPreviewFitScale(
  availableWidth: number,
  availableHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): number {
  const values = [availableWidth, availableHeight, naturalWidth, naturalHeight];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return 1;
  return Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
}
