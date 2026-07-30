import { describe, it, expect } from "@voidzero-dev/vite-plus-test";
import { Epoch } from "../src/async-epoch.ts";

describe("Epoch", () => {
  it("begin() returns a current token", () => {
    const epoch = new Epoch();
    const run = epoch.begin();
    expect(run.current).toBe(true);
  });

  it("begin() displaces the previous token", () => {
    const epoch = new Epoch();
    const first = epoch.begin();
    epoch.begin();
    expect(first.current).toBe(false);
  });

  it("latest begin() token remains current", () => {
    const epoch = new Epoch();
    epoch.begin();
    const last = epoch.begin();
    expect(last.current).toBe(true);
  });

  it("cancel() displaces the current token without creating a new one", () => {
    const epoch = new Epoch();
    const run = epoch.begin();
    epoch.cancel();
    expect(run.current).toBe(false);
  });

  it("begin() after cancel() creates a fresh current token", () => {
    const epoch = new Epoch();
    epoch.begin();
    epoch.cancel();
    const run = epoch.begin();
    expect(run.current).toBe(true);
  });

  it("id increments monotonically", () => {
    const epoch = new Epoch();
    const a = epoch.begin();
    const b = epoch.begin();
    const c = epoch.begin();
    expect(b.id).toBeGreaterThan(a.id);
    expect(c.id).toBeGreaterThan(b.id);
  });

  it("begin() aborts the previous run's signal", () => {
    const epoch = new Epoch();
    const first = epoch.begin();
    expect(first.signal.aborted).toBe(false);
    epoch.begin();
    expect(first.signal.aborted).toBe(true);
  });

  it("cancel() aborts the current signal", () => {
    const epoch = new Epoch();
    const run = epoch.begin();
    expect(run.signal.aborted).toBe(false);
    epoch.cancel();
    expect(run.signal.aborted).toBe(true);
  });

  it("concurrent begin() calls — only the last is current", () => {
    const epoch = new Epoch();
    const runs = [epoch.begin(), epoch.begin(), epoch.begin()];
    expect(runs[0].current).toBe(false);
    expect(runs[1].current).toBe(false);
    expect(runs[2].current).toBe(true);
  });
});
