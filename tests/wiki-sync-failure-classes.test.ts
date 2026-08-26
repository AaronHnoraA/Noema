/**
 * How a Git failure is classified decides whether sync backs off and retries or
 * stops and demands attention. A transient 5xx from the origin has to land in
 * `network`, which owns the 1m/5m/30m/2h backoff — `internal` gives it one free
 * retry and then hard-stops sync until a person intervenes.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { classifyGitFailure } from "../server/lib/wiki-sync.mjs";

const kind = (stderr: string): string => classifyGitFailure({ stderr }).errorKind;

describe("transient server faults are retryable network failures", () => {
  test("curl's fetch-time 5xx wording", () => {
    // What `git fetch`/`git ls-remote` actually prints over HTTPS.
    expect(kind("fatal: unable to access 'https://example.com/v.git/': The requested URL returned error: 503"))
      .toBe("network");
    expect(kind("fatal: unable to access 'https://example.com/v.git/': The requested URL returned error: 500"))
      .toBe("network");
  });

  test("the smart-HTTP RPC wording", () => {
    expect(kind("error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502"))
      .toBe("network");
  });

  test("rate limiting", () => {
    expect(kind("fatal: unable to access 'https://example.com/v.git/': The requested URL returned error: 429"))
      .toBe("network");
  });

  test("connection-level faults", () => {
    expect(kind("fatal: unable to access 'https://example.com/': Failed to connect to example.com port 443"))
      .toBe("network");
    expect(kind("fatal: the remote end hung up unexpectedly")).toBe("network");
    expect(kind("error: RPC failed; curl 56 GnuTLS recv error: early EOF")).toBe("network");
    expect(kind("ssh: connect to host example.com port 22: Connection refused")).toBe("network");
    expect(kind("fatal: unable to access 'https://example.com/': Could not resolve host: example.com"))
      .toBe("network");
    expect(kind("502 Bad Gateway")).toBe("network");
    expect(kind("503 Service Unavailable")).toBe("network");
  });
});

describe("failures that genuinely need a person keep their own class", () => {
  test("a 4xx that is not rate limiting stays out of the network bucket", () => {
    expect(kind("fatal: unable to access 'https://example.com/v.git/': The requested URL returned error: 403"))
      .not.toBe("network");
    expect(kind("fatal: unable to access 'https://example.com/v.git/': The requested URL returned error: 404"))
      .not.toBe("network");
  });

  test("credentials", () => {
    expect(kind("fatal: Authentication failed for 'https://example.com/v.git/'")).toBe("authentication");
    expect(kind("git@example.com: Permission denied (publickey).")).toBe("authentication");
  });

  test("remote configuration", () => {
    expect(kind("fatal: 'origin' does not appear to be a git repository")).toBe("configuration");
    expect(kind("fatal: couldn't find remote ref main")).toBe("configuration");
  });

  test("a push race", () => {
    expect(kind("! [rejected] main -> main (non-fast-forward)")).toBe("remote-race");
    expect(kind("hint: Updates were rejected because the remote contains work; fetch first"))
      .toBe("remote-race");
  });

  test("a dirty worktree", () => {
    expect(kind("error: Your local changes to the following files would be overwritten by merge"))
      .toBe("workspace");
    expect(kind("fatal: Unable to create '/v/.git/index.lock': File exists.")).toBe("workspace");
  });

  test("anything unrecognised is an internal error that asks for review", () => {
    const classified = classifyGitFailure({ stderr: "fatal: something nobody has seen before" });
    expect(classified.errorKind).toBe("internal");
    expect(classified.retryable).toBe(false);
    expect(classified.actionRequired).toBeTruthy();
  });
});

describe("the classifier reads the shapes callers actually pass", () => {
  test("an execFile rejection, a plain Error and a bare string", () => {
    expect(classifyGitFailure({ error: { stderr: "fatal: the remote end hung up unexpectedly" } }).errorKind)
      .toBe("network");
    expect(classifyGitFailure(new Error("fatal: Authentication failed")).errorKind).toBe("authentication");
    expect(classifyGitFailure("Could not resolve host: example.com").errorKind).toBe("network");
  });

  test("nothing at all still classifies rather than throwing", () => {
    expect(classifyGitFailure(null).errorKind).toBe("internal");
    expect(classifyGitFailure(undefined).message).toBeTruthy();
  });
});
