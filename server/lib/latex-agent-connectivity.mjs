import { lookup } from "node:dns/promises";

/** Claude's ACP adapter can retry DNS failures for minutes without an event. */
export async function claudeExportDnsError({
  backend,
  environment = process.env,
  lookupHost = lookup,
  timeoutMs = 8000,
} = {}) {
  if (backend !== "claude" || environment.ANTHROPIC_BASE_URL
      || environment.HTTPS_PROXY || environment.https_proxy
      || environment.HTTP_PROXY || environment.http_proxy) return "";
  let timer;
  try {
    await Promise.race([
      lookupHost("api.anthropic.com"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), timeoutMs);
      }),
    ]);
    return "";
  } catch (error) {
    return `Claude API DNS unavailable (api.anthropic.com: ${error?.code || error?.message || error}). Check network DNS or select Codex for export.`;
  } finally {
    clearTimeout(timer);
  }
}
