function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
}

export function supportedDiagramLang(lang: string): boolean {
  return ["mermaid", "mindmap", "marmind", "markmind"].includes(normalizeLang(lang));
}
