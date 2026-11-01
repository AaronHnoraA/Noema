export function openPlacedFile(body: Record<string, unknown>, adapters: {
  resolveFile: (file: string) => string;
  request: (method: string, body: Record<string, unknown>) => Promise<any>;
}): Promise<any>;
