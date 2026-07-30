import { highlightCode, type CodeHighlightRange } from "./code-highlight.ts";

type HighlightRequest = {
  id: number;
  lang: string;
  text: string;
};

type HighlightResponse = {
  id: number;
  ranges: CodeHighlightRange[];
};

self.addEventListener("message", (event: MessageEvent<HighlightRequest>) => {
  const { id, lang, text } = event.data;
  const response: HighlightResponse = {
    id,
    ranges: highlightCode(lang, text),
  };
  self.postMessage(response);
});
