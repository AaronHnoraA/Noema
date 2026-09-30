import { englishDefaults } from '../languages/en.js';
const ASCII_WORD = /^[A-Za-z]+$/;
function createTrieNode() {
    return {
        children: new Map(),
        values: null,
    };
}
function parsePattern(pattern) {
    let letters = '';
    let index = 0;
    const values = [0];
    for (const char of pattern) {
        if (char >= '0' && char <= '9') {
            values[index] = Number(char);
            continue;
        }
        letters += char;
        index += 1;
        values[index] ??= 0;
    }
    return { letters, values };
}
function buildPatternTrie(patterns) {
    const root = createTrieNode();
    for (const pattern of patterns) {
        if (!pattern)
            continue;
        const { letters, values } = parsePattern(pattern.toLowerCase());
        let node = root;
        for (const char of letters) {
            let next = node.children.get(char);
            if (!next) {
                next = createTrieNode();
                node.children.set(char, next);
            }
            node = next;
        }
        if (!node.values) {
            node.values = values;
        }
        else {
            const length = Math.max(node.values.length, values.length);
            const merged = Array.from({ length }).fill(0);
            for (let i = 0; i < length; i++) {
                merged[i] = Math.max(node.values[i] ?? 0, values[i] ?? 0);
            }
            node.values = merged;
        }
    }
    return root;
}
function parseExceptionWord(word) {
    const splits = [];
    let plain = '';
    for (const char of word.toLowerCase()) {
        if (char === '-') {
            splits.push(plain.length);
        }
        else {
            plain += char;
        }
    }
    return {
        key: plain,
        splits,
    };
}
function buildExceptionMap(exceptions) {
    const map = new Map();
    for (const exception of exceptions) {
        const trimmed = exception.trim();
        if (!trimmed)
            continue;
        const { key, splits } = parseExceptionWord(trimmed);
        if (key) {
            map.set(key, splits);
        }
    }
    return map;
}
function applyMinima(splits, wordLength, leftMin, rightMin) {
    return splits.filter((offset) => offset >= leftMin &&
        offset <= wordLength - rightMin &&
        offset > 0 &&
        offset < wordLength);
}
let cachedTrie = null;
let cachedExceptions = null;
let preloadPromise = null;
const hyphenatorCache = new Map();
export function preloadEnglishHyphenator() {
    if (cachedTrie && cachedExceptions) {
        return Promise.resolve();
    }
    preloadPromise ??= Promise.all([
        import('../languages/data/hyph-en-us.patterns.js'),
        import('../languages/data/hyph-en-us.exceptions.js'),
    ]).then(([patternsModule, exceptionsModule]) => {
        cachedTrie = buildPatternTrie(patternsModule.EN_US_PATTERNS);
        cachedExceptions = buildExceptionMap(exceptionsModule.EN_US_EXCEPTIONS);
    });
    return preloadPromise;
}
export class EnglishHyphenator {
    trie;
    exceptions;
    leftMin;
    rightMin;
    cache = new Map();
    constructor(trie, exceptions, options = {}) {
        this.leftMin = options.leftMin ?? englishDefaults.lefthyphenmin;
        this.rightMin = options.rightMin ?? englishDefaults.righthyphenmin;
        this.trie = trie;
        this.exceptions = exceptions;
    }
    hyphenate(word) {
        if (!ASCII_WORD.test(word)) {
            return [];
        }
        const lowerWord = word.toLowerCase();
        const cached = this.cache.get(lowerWord);
        if (cached) {
            return cached;
        }
        const exception = this.exceptions.get(lowerWord);
        if (exception) {
            const filtered = applyMinima(exception, lowerWord.length, this.leftMin, this.rightMin);
            this.cache.set(lowerWord, filtered);
            return filtered;
        }
        const wrapped = `.${lowerWord}.`;
        const scores = Array.from({ length: wrapped.length + 1 }, () => 0);
        for (let i = 0; i < wrapped.length; i++) {
            let node = this.trie;
            for (let j = i; j < wrapped.length; j++) {
                node = node.children.get(wrapped[j]);
                if (!node)
                    break;
                if (node.values) {
                    const values = node.values;
                    for (let k = 0; k < values.length; k++) {
                        const index = i + k;
                        if (index < scores.length) {
                            scores[index] = Math.max(scores[index], values[k]);
                        }
                    }
                }
            }
        }
        const splits = [];
        for (let boundary = 1; boundary <= lowerWord.length; boundary++) {
            if (scores[boundary + 1] % 2 === 1) {
                splits.push(boundary);
            }
        }
        const filtered = applyMinima(splits, lowerWord.length, this.leftMin, this.rightMin);
        this.cache.set(lowerWord, filtered);
        return filtered;
    }
}
export function createEnglishHyphenator(options = {}) {
    if (!cachedTrie || !cachedExceptions) {
        return new NoopHyphenator();
    }
    const leftMin = options.leftMin ?? englishDefaults.lefthyphenmin;
    const rightMin = options.rightMin ?? englishDefaults.righthyphenmin;
    const key = `${leftMin}:${rightMin}`;
    let cached = hyphenatorCache.get(key);
    if (!cached) {
        cached = new EnglishHyphenator(cachedTrie, cachedExceptions, { leftMin, rightMin });
        hyphenatorCache.set(key, cached);
    }
    return cached;
}
export class NoopHyphenator {
    hyphenate() {
        return [];
    }
}
