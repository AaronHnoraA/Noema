// Type surface for shared/tex-compat.mjs.

/** Environments rewritten to a supported equivalent: name -> replacement. */
export declare const COMPAT_ENVIRONMENTS: Readonly<Record<string, string>>;

/** Macro definitions injected into the renderer: name -> body. */
export declare const COMPAT_MACROS: Readonly<Record<string, string>>;

/** Rewrite every `\begin{X}`/`\end{X}` listed in COMPAT_ENVIRONMENTS. */
export declare function rewriteCompatEnvironments(source: string): string;
