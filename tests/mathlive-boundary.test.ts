import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
// @ts-expect-error MathLive does not publish declarations for its browser bundle.
import { MathfieldElement } from "../node_modules/mathlive/mathlive.mjs";

// @ts-expect-error MathLive does not publish declarations for its browser bundle.
vi.mock("mathlive", () => import("../node_modules/mathlive/mathlive.mjs"));

import {
  mountVisualTexDisplayEditor,
  mountVisualTexInlineEditor,
} from "../src/cm6/extensions/visual/widgets/visualtex-inline.ts";

function prepareMathLive(): void {
  MathfieldElement.soundsDirectory = null;
  if (!document.fonts?.ready) {
    const fonts = Object.assign(new Set(), { ready: Promise.resolve() });
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  }
  if (!("FontFace" in globalThis)) {
    Object.defineProperty(globalThis, "FontFace", {
      configurable: true,
      value: class { load(): Promise<this> { return Promise.resolve(this); } },
    });
  }
  if (!("AudioContext" in globalThis)) {
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: class { state = "running"; destination = {}; resume(): Promise<void> { return Promise.resolve(); } },
    });
  }
  const prototype = ShadowRoot.prototype as ShadowRoot & { noemaHostSelectorPatched?: boolean };
  if (!prototype.noemaHostSelectorPatched) {
    const querySelector = prototype.querySelector;
    prototype.querySelector = function (this: ShadowRoot, selector: string) {
      return querySelector.call(this, selector === ":host > span" ? "span" : selector);
    } as typeof prototype.querySelector;
    prototype.noemaHostSelectorPatched = true;
  }
}

describe("LiveTeX Cmd-bracket boundaries", () => {
  test("a nested final script reaches the formula edge before leaving", async () => {
    prepareMathLive();
    const host = document.createElement("div");
    document.body.append(host);
    const commits: string[] = [];
    const editor = mountVisualTexInlineEditor(host, {
      latex: String.raw`\frac{asdas}{asds}+asda sadas^{6}_{asdas}`,
      macros: {}, entry: { kind: "end" }, onInput: () => {},
      onCommit: (direction) => commits.push(direction ?? "none"),
      onUnavailable: (error) => { throw error; },
    });
    try {
      await editor.ready;
      const field = host.querySelector("math-field") as HTMLElement & {
        position: number; lastOffset: number;
      };
      field.position = field.lastOffset - 2;
      const press = (): void => {
        document.dispatchEvent(new CustomEvent("aaronnote:math-host-key", {
          cancelable: true,
          detail: { key: "]", code: "BracketRight", metaKey: true },
        }));
      };
      press();
      expect(commits).toEqual([]);
      expect(field.position).toBe(field.lastOffset);
      press();
      expect(commits).toEqual(["forward"]);
    } finally {
      editor.destroy();
      host.remove();
    }
  });
  for (const display of [false, true]) {
    test(`${display ? "display" : "inline"} formula leaves its root without a snippet handoff`, async () => {
      prepareMathLive();
      const host = document.createElement("div");
      document.body.append(host);
      const commits: string[] = [];
      const editor = (display ? mountVisualTexDisplayEditor : mountVisualTexInlineEditor)(host, {
        latex: "x",
        macros: {},
        entry: { kind: "end" },
        onInput: () => {},
        onCommit: (direction) => commits.push(direction ?? "none"),
        onUnavailable: (error) => { throw error; },
      });
      try {
        await editor.ready;
        const field = host.querySelector("math-field") as (HTMLElement & {
          position: number;
          lastOffset: number;
        }) | null;
        expect(field).not.toBeNull();
        field!.position = field!.lastOffset;
        const forward = new CustomEvent("aaronnote:math-host-key", {
          cancelable: true,
          detail: { key: "]", code: "BracketRight", metaKey: true },
        });
        document.dispatchEvent(forward);
        expect(forward.defaultPrevented).toBe(true);
        expect(commits).toEqual(["forward"]);

        field!.position = 0;
        const backward = new CustomEvent("aaronnote:math-host-key", {
          cancelable: true,
          detail: { key: "[", code: "BracketLeft", metaKey: true },
        });
        document.dispatchEvent(backward);
        expect(backward.defaultPrevented).toBe(true);
        expect(commits).toEqual(["forward", "backward"]);
      } finally {
        editor.destroy();
        host.remove();
      }
    });
  }

  // LiveTeX Studio splits a formula into one field per row. A row on its own
  // has no columns, so MathLive wrote `a & b` back as `a\&b`.
  for (const [name, latex] of [
    ["matrix", String.raw`\begin{pmatrix}a & b \\ c & d\end{pmatrix}`],
    ["cases", String.raw`\begin{cases}1 & x > 0 \\ 0 & \text{otherwise}\end{cases}`],
    ["continuation row", String.raw`\begin{aligned}x &= 1 \\ &\quad + 2\end{aligned}`],
    ["plain alignment", String.raw`\begin{aligned}a &= b \\ c &= d\end{aligned}`],
  ] as const) {
    test(`LiveTeX Studio returns a ${name} without rewriting its columns`, async () => {
      prepareMathLive();
      const host = document.createElement("div");
      document.body.append(host);
      const editor = mountVisualTexDisplayEditor(host, {
        latex,
        macros: {},
        entry: { kind: "end" },
        advanced: true,
        commitOnBlur: false,
        onInput: () => {},
        onCommit: () => {},
        onUnavailable: (error) => { throw error; },
      });
      try {
        await editor.ready;
        const compact = (value: string): string => value.replace(/\s+/g, "");
        expect(compact(editor.value())).toBe(compact(latex));
        expect(editor.value()).not.toContain(String.raw`\&`);
      } finally {
        editor.destroy();
        host.remove();
      }
    });
  }
});
