import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { jupyterDefaultsFromEnv } from "../server/lib/jupyter-defaults.mjs";

describe("Jupyter project defaults", () => {
  test("falls back to the ordinary Python kernel", () => {
    expect(jupyterDefaultsFromEnv({})).toEqual({
      language: "python",
      kernel: "python3",
      session: "default",
    });
  });

  test("derives the stable Sage kernel id from project language", () => {
    expect(jupyterDefaultsFromEnv({
      AARONNOTE_JUPYTER_DEFAULT_LANGUAGE: "sage",
    })).toEqual({
      language: "sage",
      kernel: "sagemath",
      session: "default",
    });
  });

  test("honours complete project overrides", () => {
    expect(jupyterDefaultsFromEnv({
      AARONNOTE_JUPYTER_DEFAULT_LANGUAGE: "python",
      AARONNOTE_JUPYTER_DEFAULT_KERNEL: "research-python",
      AARONNOTE_JUPYTER_DEFAULT_SESSION: "analysis",
    })).toEqual({
      language: "python",
      kernel: "research-python",
      session: "analysis",
    });
  });
});
