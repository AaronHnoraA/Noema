export interface CommentAuthor { name: string; kind: "person" | "agent"; session?: string }
export interface CommentMessage { mid: string; author: CommentAuthor; text: string; at: string; edited?: string }
export interface CommentThread {
  id: string; note: string; quote: string; status: "open" | "resolved"; author: CommentAuthor;
  createdAt: string; assignee: { name: string; session?: string } | null; messages: CommentMessage[];
  resolvedAt?: string; resolvedBy?: CommentAuthor;
  archived?: boolean; failure?: string; attempt?: string;
}
export const COMMENTS_FILE: string;
export function journalFor(file: string): string;
export function foldJournal(text: string): Map<string, CommentThread>;
export function listThreads(file: string): Promise<CommentThread[]>;
export function getThread(file: string, id: string): Promise<CommentThread | null>;
export function createThread(body: Record<string, unknown>): Promise<CommentThread>;
export function replyThread(body: Record<string, unknown>): Promise<CommentThread>;
export function setThreadStatus(body: Record<string, unknown>): Promise<CommentThread>;
export function editMessage(body: Record<string, unknown>): Promise<CommentThread>;
export function deleteComment(body: Record<string, unknown>): Promise<CommentThread | null>;
export function assignThread(body: Record<string, unknown>): Promise<CommentThread>;
export function moveThreads(file: string, target: string): Promise<number>;
