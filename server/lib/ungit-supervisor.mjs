import { spawn } from "node:child_process";

const [ungitBin, ...args] = process.argv.slice(2);
if (!ungitBin) throw new Error("Missing ungit executable path");

const child = spawn(process.execPath, [ungitBin, ...args], {
  stdio: ["ignore", "ignore", "inherit"],
});
let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill(signal);
}

// The owning Noema host keeps stdin open. A crash or forced quit closes the
// pipe, so the visual Git server cannot remain orphaned on the machine.
process.stdin.resume();
process.stdin.on("end", () => stop());
process.stdin.on("error", () => stop());
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop("SIGINT"));

child.once("exit", (code, signal) => {
  process.stdin.pause();
  process.exit(Number.isInteger(code) ? code : (signal ? 1 : 0));
});
