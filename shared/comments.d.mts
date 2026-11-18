export type NoteComment = { id: string; done: boolean; text: string; from: number; to: number; line: number; source: string; quote: string };
export function newCommentId(random?: () => number): string;
export function escapeCommentBody(text: string): string;
export function scanComments(source: string): NoteComment[];
export function commentSource(options: { text: string; id: string; done?: boolean }): string;
export function commentEdit(comment: NoteComment, options?: { done?: boolean; id?: string }): { oldText: string; newText: string };
export function findComment(source: string, id: string): NoteComment | null;
