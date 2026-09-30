export type ParagraphAlignment = 'ragged-right' | 'ragged-left' | 'center' | 'justified';
export declare const DEFAULT_PARAGRAPH_ALIGNMENT: ParagraphAlignment;
export interface AlignmentGlue {
    width: number;
    stretch: number;
    shrink: number;
}
export interface AlignmentProfile {
    alignment: ParagraphAlignment;
    interwordStretch: number;
    interwordShrink: number;
    leftskip: AlignmentGlue;
    rightskip: AlignmentGlue;
    parfillskip: AlignmentGlue;
    preventOverflow: boolean;
}
export declare const TEX_INTERWORD_SPACE_EM = 0.3333;
export declare const TEX_INTERWORD_STRETCH_EM: number;
export declare const TEX_INTERWORD_SHRINK_EM: number;
export declare const TIKZ_RAGGED_SKIP_STRETCH_EM = 2;
export declare function normalizeParagraphAlignment(value: unknown): ParagraphAlignment;
export declare function buildAlignmentProfile(alignment: ParagraphAlignment): AlignmentProfile;
