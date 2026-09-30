import type { SyntaxNode } from "@lezer/common";
import type { CoordinateItem, RelativeCoordinatePrefix } from "../../ast/types.js";
import type { ParsedCoordinate } from "./types.js";
export declare function mapCoordinateItem(node: SyntaxNode, source: string, statementIndex: number, itemIndex: number, relativePrefix?: RelativeCoordinatePrefix): CoordinateItem;
export declare function mapRelativeCoordinateItem(node: SyntaxNode, source: string, statementIndex: number, itemIndex: number): CoordinateItem;
export declare function parseCoordinate(raw: string): ParsedCoordinate & {
    optionsSpan?: {
        from: number;
        to: number;
    };
    optionsRaw?: string;
};
export declare function splitAllAtTopLevel(input: string, separator: string): string[];
export declare function splitAtTopLevel(input: string, separator: string): {
    left: string;
    right: string;
} | null;
