export declare const FeatureFlags: {
    readonly version: "v1";
    readonly tikzPictureEnvironment: true;
    readonly pathStatements: true;
    readonly scopeStatements: true;
    readonly foreachStatements: true;
    readonly nodeText: true;
    readonly coordinateEditing: true;
    readonly structuredOptions: true;
    readonly semanticIr: true;
    readonly svgRendering: true;
    readonly opaqueUnknownCommands: true;
    readonly strongRecovery: true;
};
export type FeatureFlagName = Exclude<keyof typeof FeatureFlags, "version">;
