export type Scomment = { id: string; done: boolean; text: string; from: number; to: number; line: number; source: string; quote: string };
export function newScommentId(random?: () => number): string;
export function escapeScommentBody(text: string): string;
export function scanScomments(source: string): Scomment[];
export function scommentSource(options: { text: string; id: string; done?: boolean }): string;
export function scommentEdit(comment: Scomment, options?: { done?: boolean; id?: string }): { oldText: string; newText: string };
export function findScomment(source: string, id: string): Scomment | null;
