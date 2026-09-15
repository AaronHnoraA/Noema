export declare const SESSION_KEYWORDS: readonly ["continue", "fork", "fresh"];
export declare const SESSION_KEYWORD_LOOKALIKES: Readonly<Record<string, "continue" | "fork" | "fresh">>;
export declare function sessionKeywordSuggestion(value: unknown): "" | "continue" | "fork" | "fresh";
export declare const PI_SESSION_NAME: "pi";

export type SessionDirective =
  | { kind: "none" }
  | { kind: "keyword"; keyword: "continue" | "fork" | "fresh" }
  | { kind: "name"; name: string }
  | { kind: "fork"; parent: string; child: string };

export type SessionRouteDecision = {
  action: "continue" | "create" | "fork" | "adopt";
  name: string;
  agent: string;
  parentName: string;
  forkMode: "" | "native" | "reconstructed";
  allowNative: boolean;
  origin: "derived" | "pi" | "user";
  rule: string;
  fromWorkNodeId: string;
  reason: string;
  autoContext: string[];
  legacySessionId: string;
};

export declare function validateSessionName(name: unknown, options?: { allowPi?: boolean }): string;
export declare function parseSessionDirective(value: unknown): SessionDirective;
export declare function sessionNameSlug(title: unknown): string;
export declare function deriveSessionRoute(input: {
  notebook?: unknown;
  workNodeId?: string;
  title?: string;
  agent?: string;
  defaultAgent?: string;
  directive?: SessionDirective;
  requestedName?: string;
  runs?: unknown[];
  names?: unknown[];
}): SessionRouteDecision;
