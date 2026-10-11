import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Where the running host listens, for local tools that are not its pages:
// the Raycast extension reads this to call the host and the kernel without
// going through Emacs.  The file is private to the user and names the
// process that wrote it, so a reader can tell a live host from a stale file.
export function hostDescriptorPath(stateRoot) {
  return join(resolve(stateRoot), "host.json");
}

export function writeHostDescriptor(stateRoot, descriptor) {
  const target = hostDescriptorPath(stateRoot);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...descriptor, pid: process.pid }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
  return target;
}

/** The descriptor under STATE-ROOT when the process that wrote it is alive. */
export function readHostDescriptor(stateRoot, isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }) {
  try {
    const descriptor = JSON.parse(readFileSync(hostDescriptorPath(stateRoot), "utf8"));
    return descriptor?.url && isAlive(Number(descriptor.pid)) ? descriptor : null;
  } catch {
    return null;
  }
}
