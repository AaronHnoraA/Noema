// Tests must never resolve the developer's real global capability scope.
// `globalPaths()` falls back to `$NOEMA_GLOBAL_CAPABILITIES`, then to
// `~/.emacs.d/etc/noema/capabilities.json`, so a Skill the host happens to
// have enabled globally (or one contributed by a linked Claude/Codex source)
// would otherwise join every prepared RunSpec and every resolved capability
// environment. Point global scope at an empty per-worker directory: only what
// a test installs is visible, and a test that wants a populated global scope
// still stubs these variables itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scope = mkdtempSync(join(tmpdir(), "noema-test-global-"));
process.env.NOEMA_GLOBAL_CAPABILITIES = join(scope, "capabilities.json");
process.env.NOEMA_GLOBAL_SKILLS = join(scope, "skills");
process.on("exit", () => rmSync(scope, { recursive: true, force: true }));
