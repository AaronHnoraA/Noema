import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function captureTokenFile(stateRoot) {
  return join(stateRoot, "capture-token");
}

export async function ensureCaptureToken(stateRoot) {
  const file = captureTokenFile(stateRoot);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
      await chmod(file, 0o600);
      return token;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(file, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = (await readFile(file, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(existing)) throw new Error("Existing capture token is invalid");
    await chmod(file, 0o600);
    return existing;
  }
}

export function captureRequestAuthorized(header, token) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(header || "").trim());
  if (!match || !token) return false;
  const offered = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}
