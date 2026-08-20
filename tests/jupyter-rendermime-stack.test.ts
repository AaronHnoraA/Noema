import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Noema Jupyter MIME stack", () => {
  const source = readFileSync(join(process.cwd(), "src/jupyter-rendermime.ts"), "utf8");

  test("keeps the upstream JupyterLab renderers and explicitly typesets nested HTML", () => {
    expect(source).toContain("standardRendererFactories.filter(");
    expect(source).toContain("stockHtmlFactory.createRenderer(this.options)");
    expect(source).toContain("katexTypesetter().typeset(inner.node)");
    expect(source).toContain("htmlMathOnly(html)");
    expect(source).toContain('mimeTypes: ["text/html"]');
  });

  test("renders standard and extension JSON bundles without hiding text fallbacks", () => {
    expect(source).toContain("class AaronnoteJsonRenderer");
    expect(source).toContain('mimeTypes: ["application/json"]');
    expect(source).toContain("JSON.stringify(value, null, 2)");
    expect(source).toContain("/^application\\/[\\w.+-]+\\+json$/i");
    expect(source).toContain("addJsonMimeFactory(registry, mimeType, 125)");
    expect(source).toContain("addJsonMimeFactory(rendermime, mimeType, 125)");
  });

  test("exposes an incremental OutputArea model instead of recreating its DOM", () => {
    expect(source).toContain("export type JupyterOutputView");
    expect(source).toContain("dispose.clear = () => model.clear()");
    expect(source).toContain("model.set(index, output as never)");
    expect(source).toContain("model.add(output as never)");
  });

});
