export function createCommentApiHandlers(options?: {
  changed?: (file: string) => void;
  ask?: (payload: { file: string; id: string; text: string; quote: string }) => void;
}): Record<string, (body: any) => Promise<any>>;
