import type { ParseTikzResult } from "../parser/index.js";
import type { EvaluateTikzResult } from "../semantic/evaluate.js";
import type { EmitSvgResult } from "../svg/types.js";
import type { EditHandle, SceneFigure } from "../semantic/types.js";
import type { EditIntent, EditIntentResult } from "./types.js";
export declare class EditorSession {
    private _source;
    private _revision;
    private readonly _sessionId;
    private _parseResult;
    private _semanticResult;
    private _svgResult;
    constructor(initialSource: string);
    get source(): string;
    get revision(): number;
    get editHandles(): EditHandle[];
    get scene(): SceneFigure | null;
    get svg(): EmitSvgResult | null;
    get parseResult(): ParseTikzResult | null;
    get semanticResult(): EvaluateTikzResult | null;
    setSource(source: string): void;
    applyIntent(intent: EditIntent): EditIntentResult;
    private refresh;
    private sourceFingerprint;
}
