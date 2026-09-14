export interface ExtractedCapture {
  url: string;
  title: string;
  html: string;
  language: string;
}

export function extractCapture(mode: "selection" | "page"): ExtractedCapture;
