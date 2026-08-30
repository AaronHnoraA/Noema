/** Typed facade over the browser/server-shared revision-kind vocabulary. */

// @ts-ignore Shared ESM module outside the renderer TypeScript graph.
import { DEFAULT_REVISION_KIND, REVISION_KINDS, revisionKind, revisionKindId } from "../shared/revision-kinds.mjs";

export type RevisionKind = {
  id: string;
  label: string;
  latexLabel: string;
  color: string;
  latexColor: string;
  legacy: string;
};

const kinds = REVISION_KINDS as RevisionKind[];

export { DEFAULT_REVISION_KIND };
export const revisionKinds: readonly RevisionKind[] = kinds;
export const revisionKindOf = revisionKind as (value: string) => RevisionKind;
export const revisionKindIdOf = revisionKindId as (value: string) => string;
