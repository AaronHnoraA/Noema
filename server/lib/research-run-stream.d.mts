export function pumpResearchRunStream(options: {
  service: {
    liveRun?(body: Record<string, unknown>): Promise<Record<string, any>>;
    run?(body: Record<string, unknown>): Promise<Record<string, any>>;
  };
  root: string;
  runId: string;
  after?: number;
  limit?: number;
  pollMs?: number;
  detail?: "full" | "status";
  write(snapshot: Record<string, any>): void | Promise<void>;
  wait?(milliseconds: number): Promise<void>;
  closed?(): boolean;
}): Promise<number>;
