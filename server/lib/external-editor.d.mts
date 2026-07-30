export type VSCodeOpenCommand = {
  command: string;
  args: string[];
};

export function findVSCodeCli(env?: NodeJS.ProcessEnv): string;

export function vscodeOpenCommand(options?: {
  file?: string;
  line?: number;
  col?: number;
  cli?: string;
  platform?: NodeJS.Platform;
}): VSCodeOpenCommand;

export function taggedSourceLocation(
  file: string,
  tag: string,
  fallbackLine?: number,
  fallbackCol?: number,
): Promise<{ line: number; col: number }>;

export function openInVSCode(
  body?: string | { file?: string; tag?: string; line?: number; col?: number },
  options?: {
    env?: NodeJS.ProcessEnv;
    run?: (...args: unknown[]) => Promise<unknown>;
  },
): Promise<{
  ok: boolean;
  editor?: "vscode";
  newWindow?: boolean;
  file: string;
  line?: number;
  col?: number;
  message?: string;
}>;
