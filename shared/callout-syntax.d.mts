export function parseQuotedCallout(line: string): {
  kind: string;
  fold: "+" | "-" | "";
  title: string;
} | null;
