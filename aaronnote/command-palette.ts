export type AaronnoteCommand = {
  id: string;
  title: string;
  group: string;
  keywords?: readonly string[];
  enabled?: () => boolean;
  run: () => void | Promise<void>;
};

export function commandEnabled(command: AaronnoteCommand): boolean {
  return command.enabled?.() !== false;
}

export function commandSearchText(command: AaronnoteCommand): string {
  return [
    command.id,
    command.title,
    command.group,
    ...(command.keywords ?? []),
  ].join(" ").toLowerCase();
}

export function commandMatches(command: AaronnoteCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((part) => commandSearchText(command).includes(part));
}

export function filterCommands(
  commands: readonly AaronnoteCommand[],
  query: string,
  limit = 16,
): AaronnoteCommand[] {
  return commands
    .filter(commandEnabled)
    .filter((command) => commandMatches(command, query))
    .slice(0, Math.max(0, limit));
}

export function clampCommandIndex(index: number, commandCount: number): number {
  if (commandCount <= 0) return 0;
  return Math.max(0, Math.min(index, commandCount - 1));
}
