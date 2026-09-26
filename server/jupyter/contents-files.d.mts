export function jupyterContentsLocation(file: unknown): { serverId: string; path: string } | null;
export function contentsPath(value: unknown): string;
export function createContentsFiles(options: { servers: any }): {
  request(body: Record<string, any>): Promise<any>;
  readFile(file: string, encoding?: BufferEncoding): Promise<Buffer | string>;
  writeFile(file: string, data: string | Buffer, encoding?: BufferEncoding): Promise<any>;
  stat(file: string): Promise<{ size: number; mtimeMs: number; mtime: Date; isDirectory(): boolean; isFile(): boolean }>;
  mkdir(file: string, options?: { recursive?: boolean }): Promise<any>;
  rm(file: string, options?: { recursive?: boolean; force?: boolean }): Promise<any>;
  rename(from: string, to: string): Promise<any>;
};
