export type DesktopDropDisposition =
  | { type: "open"; paths: string[] }
  | { type: "insert"; paths: string[] };

export function isMarkdownFilePath(file: unknown): boolean;
export function desktopDropDisposition(
  files: Iterable<unknown> | ArrayLike<unknown>,
  forceAttachment?: boolean,
): DesktopDropDisposition;
