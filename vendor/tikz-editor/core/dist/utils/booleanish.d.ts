export type ParseBooleanishOptions = {
    allowOnOff?: boolean;
    allowNoneAsFalse?: boolean;
    empty?: boolean | null;
};
export declare function parseBooleanishNormalized(input: string, options?: ParseBooleanishOptions): boolean | null;
