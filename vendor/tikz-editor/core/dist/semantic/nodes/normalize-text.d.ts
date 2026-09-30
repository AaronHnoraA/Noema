export declare function normalizeEscapedTextSpaces(text: string): string;
export type NormalizedNodeText = {
    text: string;
    fontSizePt: number;
};
/**
 * Remove inline font-size switches from node text and apply their effect to the
 * effective font size used for measurement and rendering.
 */
export declare function normalizeNodeTextFontSize(text: string, baseFontSizePt: number): NormalizedNodeText;
