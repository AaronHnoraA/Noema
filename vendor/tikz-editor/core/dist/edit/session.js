import { parseTikz } from "../parser/index.js";
import { evaluateTikzFigure } from "../semantic/evaluate.js";
import { emitSvg } from "../svg/emit.js";
import { applyEditIntent } from "./apply.js";
let nextEditorSessionId = 1;
export class EditorSession {
    _source;
    _revision = 0;
    _sessionId = nextEditorSessionId++;
    _parseResult = null;
    _semanticResult = null;
    _svgResult = null;
    constructor(initialSource) {
        this._source = initialSource;
        this.refresh();
    }
    get source() {
        return this._source;
    }
    get revision() {
        return this._revision;
    }
    get editHandles() {
        return this._semanticResult?.editHandles ?? [];
    }
    get scene() {
        return this._semanticResult?.scene ?? null;
    }
    get svg() {
        return this._svgResult;
    }
    get parseResult() {
        return this._parseResult;
    }
    get semanticResult() {
        return this._semanticResult;
    }
    setSource(source) {
        if (source === this._source) {
            return;
        }
        this._source = source;
        this._revision += 1;
        this.refresh();
    }
    applyIntent(intent) {
        const result = applyEditIntent(this._source, this.editHandles, intent, {
            sourceFingerprint: this.sourceFingerprint()
        });
        if (result.kind === "success") {
            this._source = result.newSource;
            this._revision += 1;
            this.refresh();
        }
        return result;
    }
    refresh() {
        this._parseResult = parseTikz(this._source);
        this._semanticResult = evaluateTikzFigure(this._parseResult.figure, this._source, { sourceFingerprint: this.sourceFingerprint() });
        this._svgResult = emitSvg(this._semanticResult.scene);
    }
    sourceFingerprint() {
        return `editor-session:${this._sessionId}:${this._revision}:${this._source.length}`;
    }
}
