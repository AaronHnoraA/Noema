import type { NodeTextEngine } from "./types.js";
export type MathJaxFont = "mathjax-newcm" | "mathjax-asana" | "mathjax-bonum" | "mathjax-dejavu" | "mathjax-fira" | "mathjax-modern" | "mathjax-pagella" | "mathjax-schola" | "mathjax-stix2" | "mathjax-termes" | "mathjax-tex";
type WorkerFontLoader = (name: string) => Promise<unknown>;
/**
 * Register a font loader for the worker runtime. Must be called before the first
 * render so that mathjax.asyncLoad can route bare-specifier font imports through
 * Vite-bundled lazy chunks instead of failing with a module resolution error.
 */
export declare function setWorkerFontLoader(loader: WorkerFontLoader): void;
export declare function createMathJaxNodeTextEngine(options?: {
    font?: MathJaxFont;
}): Promise<NodeTextEngine>;
export declare function getActiveMathJaxOutputJax(): unknown;
export {};
