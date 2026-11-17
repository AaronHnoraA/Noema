export function createCommentApiHandlers(options?: {
  changed?: (file: string, origin?: { fromEmacs?: boolean }) => void;
}): Record<string, (body: any) => Promise<any>>;
