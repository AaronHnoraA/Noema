import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  normalizeServerDeployConfig,
  normalizeServerRuntimeConfig,
} from "../server/lib/server-config.mjs";
import {
  assertServerApiChannel,
  serverApiChannelAllowed,
  serverApiCompatibilityResult,
} from "../server/lib/server-policy.mjs";

describe("Server configuration and read-only policy", () => {
  test("keeps three deploy releases by default", () => {
    const config = normalizeServerDeployConfig({
      schemaVersion: 1,
      sshTarget: "server",
      remoteRoot: "/srv/noema",
      nodeBin: "/usr/bin/node",
      npmBin: "/usr/bin/npm",
    });
    expect(config.retainReleases).toBe(3);
  });

  test("normalizes explicit public/private repositories and runtime paths", () => {
    const config = normalizeServerRuntimeConfig({
      schemaVersion: 1,
      listen: { host: "127.0.0.1", port: 6180 },
      reader: { showGraph: false },
      pullIntervalMinutes: 30,
      repositories: [
        { name: "math", url: "https://example.test/math.git", partition: "public", branch: "auto" },
        { name: "journal", url: "git@example.test:journal.git", partition: "private", branch: "master" },
      ],
    }, { configFile: "/srv/noema/server-config/runtime.json" });

    expect(config.noteRoot).toBe("/srv/noema/server-config/repos");
    expect(config.repositories.map((repository) => repository.id)).toEqual(["public/math", "private/journal"]);
    expect(config.listen.port).toBe(6180);
    expect(config.appearance.theme).toBe("claude");
    expect(config.reader).toMatchObject({
      showSource: false,
      showGraph: false,
      showSearch: true,
      showToc: true,
      showStatus: false,
      selectionToolbar: false,
      customContextMenu: false,
      editingAids: false,
    });
  });

  test("rejects duplicate ids, embedded credentials, and unsafe deploy values", () => {
    expect(() => normalizeServerRuntimeConfig({
      schemaVersion: 1,
      repositories: [
        { name: "notes", url: "https://example.test/a.git", partition: "public" },
        { name: "notes", url: "https://example.test/b.git", partition: "public" },
      ],
    })).toThrow(/unique/);
    expect(() => normalizeServerRuntimeConfig({
      schemaVersion: 1,
      repositories: [{ name: "notes", url: "https://token@example.test/a.git", partition: "public" }],
    })).toThrow(/credentials/);
    expect(() => normalizeServerDeployConfig({
      schemaVersion: 1,
      sshTarget: "server; reboot",
      remoteRoot: "/srv/noema",
      nodeBin: "/usr/bin/node",
      npmBin: "/usr/bin/npm",
    })).toThrow(/sshTarget/);
    expect(() => normalizeServerRuntimeConfig({ schemaVersion: 1, reader: { showSource: "yes" } }))
      .toThrow(/true or false/);
    expect(() => normalizeServerDeployConfig({
      schemaVersion: 1,
      sshTarget: "server",
      remoteRoot: "/srv/noema",
      nodeBin: "/usr/bin/node",
      npmBin: "/usr/bin/npm",
      retainReleases: 1,
    })).toThrow(/retainReleases/);
  });

  test("allows reader APIs, supplies compatibility no-ops, and rejects mutation", () => {
    expect(serverApiChannelAllowed("aaronnote:api:wiki:search")).toBe(true);
    expect(serverApiChannelAllowed("aaronnote:api:knowledge:search")).toBe(true);
    expect(serverApiChannelAllowed("aaronnote:api:jupyter-cell:read-script-cell")).toBe(true);
    expect(serverApiChannelAllowed("aaronnote:api:jupyter-cell:execute-script-cell")).toBe(false);
    expect(serverApiCompatibilityResult("aaronnote:api:session:save-position"))
      .toEqual({ ok: true, stored: false });
    expect(() => assertServerApiChannel("aaronnote:api:wiki:create-page"))
      .toThrow(/unavailable/);
  });
});
