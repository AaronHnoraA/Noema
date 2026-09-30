export type PgfRandom = {
    getSeed(): number;
    setSeed(value: number): void;
    nextRaw(): number;
    rnd(): number;
    rand(): number;
    randomInteger(from: number, to: number): number;
};
export declare function createPgfRandom(initialSeed?: number): PgfRandom;
