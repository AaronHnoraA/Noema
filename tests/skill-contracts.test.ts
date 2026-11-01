// @vitest-environment node
// A Skill is documentation that an Agent acts on, so it fails silently when the
// code moves.  These contracts hold every maintained Skill to the live surface.
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const noema = process.cwd();
const emacs = resolve(noema, "../..");
const directories = [join(noema, "resources/skills"), join(emacs, ".agents/skills")];
const skills = directories.filter(existsSync).flatMap((directory) => readdirSync(directory)
  .filter((name) => existsSync(join(directory, name, "SKILL.md")))
  .map((name) => ({ name, file: join(directory, name, "SKILL.md"),
    text: readFileSync(join(directory, name, "SKILL.md"), "utf8") })));

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".mjs") ? [path] : [];
  });
}
const handlers = sources(join(noema, "server/Features")).map((file) => readFileSync(file, "utf8")).join("\n");
const channelExists = (channel: string) => {
  const [domain, ...rest] = channel.split(":");
  const name = rest.join(":");
  return handlers.includes(`"noema:api:${channel}"`)
    || (domain === "research" && handlers.includes(`"${name}":`));
};

describe.each(skills)("Skill $name", ({ name, text }) => {
  test("declares its name and a usable description", () => {
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(new RegExp(`^name: ${name}$`, "m"));
    const description = /^description: (.+)$/m.exec(text)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  test("stays small enough to read on demand", () => {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024);
  });

  test("names only API channels that exist", () => {
    const channels = [...text.matchAll(/`(?:noema:api:)?((?:agent|emacs|research):[a-z][a-z:-]*)`/g)].map((match) => match[1]);
    expect(channels.filter((channel) => !channelExists(channel))).toEqual([]);
  });

  test("points only at files that exist", () => {
    const paths = [...text.matchAll(/~\/\.config\/emacs\/[\w./-]+/g)].map((match) => match[0].replace(/[.,]$/, ""));
    expect(paths.filter((path) => !existsSync(path.replace("~/.config/emacs", emacs)))).toEqual([]);
  });
});
