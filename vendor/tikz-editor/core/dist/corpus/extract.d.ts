export type TikzSnippetKind = "tikzpicture" | "tikz-inline";
export type TikzSnippet = {
    id: string;
    kind: TikzSnippetKind;
    filePath: string;
    source: string;
    span: {
        from: number;
        to: number;
    };
    startLine: number;
    endLine: number;
    incomplete: boolean;
};
export declare function collectTikzSnippetsFromDocs(rootDir: string): TikzSnippet[];
export declare function extractTikzSnippetsFromSource(source: string, filePath: string): TikzSnippet[];
