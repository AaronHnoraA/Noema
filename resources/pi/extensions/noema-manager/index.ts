// Emacs-owned Pi integration. Source is versioned; deployment links this file.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ALLOWED = /^mcp__noema-(?:api|coordinator)__/;

/** A project Pi keeps its Project's watches for as long as it runs. */
async function startWatcher() {
  const source = process.env.NOEMA_PI_SOURCE;
  const root = process.env.NOEMA_PI_SCOPE;
  if (!source || !root || root === "emacs") return null;
  const load = (file: string) => import(pathToFileURL(join(source, file)).href);
  const { callAgentApi } = await load("server/lib/agent-api-client.mjs");
  const { resolveGraphRoot } = await load("server/lib/project-graph.mjs");
  const { createPiWatcher } = await load("resources/pi/extensions/noema-manager/watcher.mjs");
  const watcher = createPiWatcher({ root: await resolveGraphRoot(root), deliver: {
    pi: (body: any) => callAgentApi("noema:api:emacs:pi", [body]),
    agent: (body: any) => callAgentApi("noema:api:emacs:agent", [body]),
  } });
  await watcher.start();
  return watcher;
}

export default function (pi: any) {
  let watcher: Promise<any> | null = null;
  const restrict = () => {
    const wanted = pi.getAllTools().map((tool: any) => tool.name)
      .filter((name: string) => ALLOWED.test(name));
    const active = pi.getActiveTools();
    if (wanted.length !== active.length || wanted.some((name: string) => !active.includes(name)))
      pi.setActiveTools(wanted);
  };
  pi.on("session_start", () => {
    restrict();
    watcher ??= startWatcher().catch(() => null);
  });
  pi.on("session_shutdown", async () => {
    (await watcher)?.stop();
    watcher = null;
  });
  pi.on("before_agent_start", async (event: any, context: any) => {
    restrict();
    try {
      const source = process.env.NOEMA_PI_SOURCE;
      if (!source) throw new Error("No Emacs-owned Noema source");
      const { callAgentApi } = await import(pathToFileURL(join(source, "server/lib/agent-api-client.mjs")).href);
      const { renderAgentCatalog } = await import(pathToFileURL(join(source, "server/lib/agent-catalog-text.mjs")).href);
      const scope = process.env.NOEMA_PI_SCOPE;
      const catalog = await callAgentApi("noema:api:agent:skill:list", [{
        ...(scope === "emacs" ? { scope: "global" } : { root: scope || context.cwd }),
      }], { fetcher: (url: string, options: any) => fetch(url, { ...options, signal: AbortSignal.timeout(3000) }) });
      return { systemPrompt: event.systemPrompt + "\n\nAvailable Noema Skills (read one through agent:skill:read):\n"
        + renderAgentCatalog(catalog) };
    } catch {
      return { systemPrompt: event.systemPrompt + "\n\nSkill catalog is currently unavailable. Query agent:skill:list when the Noema host is ready; do not assume that no Skills exist." };
    }
  });
  pi.on("tool_call", (event: any) =>
    ALLOWED.test(event.toolName) ? undefined : { block: true, reason: "Use the Noema API or coordinator tools." });
}
