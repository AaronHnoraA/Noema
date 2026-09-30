import type { EditParseOptions } from "../parse-options.js";
import { type PropertyTargetResolution } from "../property-target.js";
export type InspectorTargetResolver = (targetId: string) => PropertyTargetResolution;
export declare function createInspectorTargetResolver(source: string, parseOptions?: EditParseOptions): InspectorTargetResolver;
