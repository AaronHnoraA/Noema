export type EmbedQueryDiagnostic = { kind: string; message: string };
export type EmbedQuerySpec = {
  title: string;
  statement: string;
  blockId: string;
  headingMode: number;
  breadcrumb: boolean;
  diagnostics: EmbedQueryDiagnostic[];
};

export function parseEmbedQuerySpec(title?: string, body?: string): EmbedQuerySpec;
