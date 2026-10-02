/** Media written with image syntax plays inline (files.md, Marker). */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../src/cm6/editor-cm6.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { mediaPlayerKind } from "../src/visual-attachments.ts";
import type { Editor } from "../src/editor-api.ts";

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); document.body.replaceChildren(); });

describe("media players", () => {
  it("classifies by the path's extension", () => {
    expect(mediaPlayerKind("a/b.MP4?x=1")).toBe("video");
    expect(mediaPlayerKind("talk.mp3#t=3")).toBe("audio");
    expect(mediaPlayerKind("pic.png")).toBeNull();
    expect(mediaPlayerKind("mp4")).toBeNull();
  });

  it("export renders a player with its caption", () => {
    const html = renderMarkdownHTML("![Demo](clip.webm)\n\n![](talk.mp3)");
    expect(html).toMatch(/<video class="cm-image-render cm-media-player" src="clip\.webm" controls(?:="")? preload="metadata" playsinline(?:="")? title="Demo"><\/video>/);
    expect(html).toContain("<figcaption class=\"cm-image-caption\">Demo</figcaption>");
    expect(html).toMatch(/<audio [^>]*src="[^"]*talk\.mp3"/);
  });

  it("the editor shows a player instead of a broken image", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const ed = createEditorCM6(host, { initialContent: "text\n\n![Demo](clip.mp4)\n\nmore" });
    editors.push(ed);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const video = host.querySelector<HTMLVideoElement>("video.cm-media-player");
    expect(video).not.toBeNull();
    expect(video!.controls).toBe(true);
    expect(video!.autoplay).toBe(false);
    expect(host.querySelector("img.cm-image-render")).toBeNull();
  });
});
