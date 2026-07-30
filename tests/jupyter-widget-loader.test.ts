import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import requireJsSource from "requirejs/require.js?raw";
import { evaluateAmdLoaderSource, validWidgetModuleName, widgetModuleCdnUrl, widgetModuleCdnUrls } from "../src/jupyter-widget-loader.ts";

describe("Jupyter custom widget loader", () => {
  test("maps unscoped and scoped AMD modules to VS Code-compatible CDN dist entries", () => {
    expect(widgetModuleCdnUrl("bqplot", "^0.12.45"))
      .toBe("https://cdn.jsdelivr.net/npm/bqplot@0.12.45/dist/index.js");
    expect(widgetModuleCdnUrl("@jupyter-widgets/jupyterlab-sidecar", "~0.7.0"))
      .toBe("https://cdn.jsdelivr.net/npm/@jupyter-widgets/jupyterlab-sidecar@~0.7.0/dist/index.js");
    expect(widgetModuleCdnUrl("pkg/custom", "1.2.3"))
      .toBe("https://cdn.jsdelivr.net/npm/pkg@1.2.3/dist/custom.js");
    expect(widgetModuleCdnUrls("pkg/custom", "1.2.3")).toEqual([
      "https://cdn.jsdelivr.net/npm/pkg@1.2.3/dist/custom.js",
      "https://unpkg.com/pkg@1.2.3/dist/custom",
    ]);
  });

  test("rejects path traversal and URL-shaped module names", () => {
    expect(validWidgetModuleName("../evil")).toBe(false);
    expect(validWidgetModuleName("https://example.com/x")).toBe(false);
    expect(() => widgetModuleCdnUrl("pkg/../../evil", "1.0.0")).toThrow(/Invalid widget module name/);
  });

  test("recovers AMD bindings from the bundled RequireJS function scope", () => {
    const bindings = evaluateAmdLoaderSource(requireJsSource);
    expect(bindings.requirejs).toBeTypeOf("function");
    expect(bindings.require).toBe(bindings.requirejs);
    expect(bindings.define).toBeTypeOf("function");
    expect((bindings.define as { amd?: unknown }).amd).toBeTruthy();
  });
});
