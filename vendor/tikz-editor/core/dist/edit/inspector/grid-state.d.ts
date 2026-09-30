import type { PathStatement } from "../../ast/types.js";
import type { SceneElement } from "../../semantic/types.js";
import type { EditParseOptions } from "../parse-options.js";
export type GridInspectorState = {
    keywordId: string;
    step: number;
    xstep: number;
    ystep: number;
};
export declare function resolveGridInspectorState(element: SceneElement, source: string, parseOptions?: EditParseOptions): GridInspectorState | null;
export declare function findPathStatementInSource(source: string, sourceId: string, parseOptions?: EditParseOptions): PathStatement | null;
