import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EventEmitter } from "node:events";
import { createInputSourceSwitcher } from "../server/lib/input-source.mjs";

function fakeSpawn() {
  const written: string[] = [];
  let spawned = 0;
  const spawnImpl = () => {
    spawned += 1;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      killed: false,
      stdin: Object.assign(new EventEmitter(), { writable: true, write: (chunk: string) => { written.push(chunk); return true; }, end() {} }),
      kill() { this.killed = true; },
    });
    return child;
  };
  return { spawnImpl, written, spawned: () => spawned };
}

describe("Vim input methods: the host keeps the keyboard Latin outside Insert", () => {
  test("Normal selects a Latin layout and anything else restores, through one long-lived helper", () => {
    const fake = fakeSpawn();
    const switcher = createInputSourceSwitcher({ helper: process.execPath, platform: "darwin", spawnImpl: fake.spawnImpl as never });
    expect(switcher.set("normal")).toMatchObject({ available: true, command: "normal" });
    expect(switcher.set("insert")).toMatchObject({ available: true, command: "restore" });
    switcher.set("normal");
    expect(fake.written).toEqual(["normal\n", "restore\n", "normal\n"]);
    expect(fake.spawned()).toBe(1);
  });

  test("without the helper or off macOS it is a no-op", () => {
    const fake = fakeSpawn();
    expect(createInputSourceSwitcher({ helper: "/nonexistent/helper", platform: "darwin", spawnImpl: fake.spawnImpl as never }).set("normal"))
      .toEqual({ ok: true, available: false });
    expect(createInputSourceSwitcher({ helper: process.execPath, platform: "linux", spawnImpl: fake.spawnImpl as never }).set("normal"))
      .toEqual({ ok: true, available: false });
    expect(fake.spawned()).toBe(0);
  });
});
