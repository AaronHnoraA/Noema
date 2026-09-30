export interface Hyphenator {
    hyphenate(word: string): number[];
}
interface HyphenatorOptions {
    leftMin?: number;
    rightMin?: number;
}
interface TrieNode {
    children: Map<string, TrieNode>;
    values: number[] | null;
}
export declare function preloadEnglishHyphenator(): Promise<void>;
export declare class EnglishHyphenator implements Hyphenator {
    private readonly trie;
    private readonly exceptions;
    private readonly leftMin;
    private readonly rightMin;
    private readonly cache;
    constructor(trie: TrieNode, exceptions: Map<string, number[]>, options?: HyphenatorOptions);
    hyphenate(word: string): number[];
}
export declare function createEnglishHyphenator(options?: HyphenatorOptions): Hyphenator;
export declare class NoopHyphenator implements Hyphenator {
    hyphenate(): number[];
}
export {};
