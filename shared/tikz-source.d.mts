export const TIKZ_DEFAULT_BASE_PT: number;

export type TikzSourceKind = "empty" | "document" | "picture" | "commands";

export interface TikzClassification {
  kind: TikzSourceKind;
  body: string;
}

export interface TikzIntrinsicSize {
  widthPt: number;
  heightPt: number;
}

export interface TikzIntrinsicEm {
  widthEm: number;
  heightEm: number;
}

export function stripTexComments(source: string): string;
export function classifyTikzSource(source: string): TikzClassification;
export function tikzPictureSource(source: string): string;
export function tikzBasePt(source: string): number;
export function tikzStandaloneDocument(source: string): string;
export function tikzSourceHash(source: string): string;
export function tikzAssetId(id: string, fallback?: string): string;
export function tikzAssetFileName(id: string, source: string): string;
export function tikzAssetFilePattern(id: string): RegExp;
export function tikzSvgIntrinsicSize(svg: string): TikzIntrinsicSize;
export function tikzIntrinsicEm(size: TikzIntrinsicSize, basePt?: number): TikzIntrinsicEm;
export function noteAssetFolderName(noteFile: string, fallback?: string): string;
export function tikzAssetMarkdownPath(noteFile: string, id: string, source: string): string;
