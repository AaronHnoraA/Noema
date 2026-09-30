import type { SceneElement } from "../../semantic/types.js";
import type { EditParseOptions } from "../parse-options.js";
import { type InspectorTargetResolver } from "./target-resolver.js";
import type { InspectorDescriptor, InspectorSnapshot } from "./types.js";
export type TreeNodeDescriptorResolver = (element: SceneElement, snapshot: InspectorSnapshot, resolveTarget: InspectorTargetResolver) => InspectorDescriptor;
export declare function buildMatrixInspectorDescriptor(source: string, matrixId: string, parseOptions?: EditParseOptions, resolveTarget?: InspectorTargetResolver): InspectorDescriptor | null;
export declare function buildTreeInspectorDescriptor(source: string, sourceId: string, element: SceneElement | null, parseOptions?: EditParseOptions, resolveTarget?: InspectorTargetResolver, resolveNodeDescriptor?: TreeNodeDescriptorResolver): InspectorDescriptor | null;
