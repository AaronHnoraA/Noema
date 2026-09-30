export type FormatTikzSourceOptions = {
    indentUnit?: string;
    collapseBlankLines?: boolean;
    reflowLongOptionLists?: boolean;
    maxLineLength?: number;
};
export declare function formatTikzSource(source: string, options?: FormatTikzSourceOptions): string;
