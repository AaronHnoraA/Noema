export interface CommentAnchor { from: number; to: number; textFrom: number; textTo: number; text: string; id: string }
export const COMMENT_ID_RE: RegExp;
export function scanCommentAnchors(source: string): CommentAnchor[];
export function stripCommentAnchors(source: string): string;
export function commentAnchor(text: string, id: string): string;
export function newCommentId(now?: Date, random?: () => number): string;
