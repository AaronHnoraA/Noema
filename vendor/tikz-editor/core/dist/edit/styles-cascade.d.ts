import type { SceneElement } from "../semantic/types.js";
import type { EditAction, StyleLevel } from "./actions.js";
import { type InspectorDescriptor, type InspectorProperty, type InspectorSnapshot, type SetPropertyWriteTarget } from "./inspector.js";
import { type SemanticPropertyId } from "./property-registry.js";
export type StylesCascadeDeclarationStatus = "active" | "overridden" | "inactive-default" | "unsupported" | "disabled";
export type StylesEditablePropertyCatalogEntry = {
    propertyId: string;
    label: string;
    kind: InspectorProperty["kind"];
};
export type StylesCascadeDeclaration = {
    id: string;
    propertyId: string | null;
    label: string;
    cssValue: string;
    status: StylesCascadeDeclarationStatus;
    property: InspectorProperty | null;
    writeTargets: SetPropertyWriteTarget[];
    sourceText: string;
    readOnlyReason?: string;
};
export type StylesCascadeSection = {
    id: string;
    kind: "command" | "scope" | "named-style" | "global" | "default";
    title: string;
    subtitle: string | null;
    sourceLevel: StyleLevel | null;
    sourceLabel: string | null;
    sourceLocation: string | null;
    writable: boolean;
    readOnlyReason?: string;
    declarations: StylesCascadeDeclaration[];
    addableProperties: StylesEditablePropertyCatalogEntry[];
    addPropertyTemplates: Record<string, InspectorProperty>;
    writeTargets: SetPropertyWriteTarget[];
};
export type StylesCascadeModel = {
    elementKind: InspectorDescriptor["elementKind"];
    elementIds: string[];
    sections: StylesCascadeSection[];
    comparableSignature: string;
};
export declare function buildStylesCascadeModel(element: SceneElement, snapshot: InspectorSnapshot, descriptor?: InspectorDescriptor): StylesCascadeModel;
export declare function buildSharedStylesCascadeModel(models: StylesCascadeModel[]): StylesCascadeModel | null;
export declare function areStylesCascadeModelsIdentical(models: StylesCascadeModel[]): boolean;
export declare function planStylesSetPropertyActions(writeTargets: readonly SetPropertyWriteTarget[], mutation: {
    key: string;
    value: string;
    clearKeys?: string[];
    propertyId?: SemanticPropertyId;
}): EditAction[];
export declare function planStylesTogglePropertyActions(writeTargets: readonly SetPropertyWriteTarget[], mutation: {
    key: string;
    mode: "disable" | "enable";
    sourceText: string;
}): EditAction[];
export declare function planStylesRemovePropertyActions(writeTargets: readonly SetPropertyWriteTarget[], key: string): EditAction[];
export declare function planStylesRenamePropertyActions(writeTargets: readonly SetPropertyWriteTarget[], oldKey: string, newKey: string, currentValue: string): EditAction[];
