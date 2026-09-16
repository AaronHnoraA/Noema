/** Real headless host + Go kernel integration check, using disposable sources.
 * No personal vault, Emacs session, Agent run or EventKit access is required.
 * Startup waits for the process's ready message, never polls an endpoint.
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "noema-agenda-host-")));
const knowledge = join(temporary, "knowledge");
const project = join(temporary, "project");
const routed = process.env.NOEMA_AGENDA_ROUTED_TEST === "1";
const identity = (file) => routed ? `/fs:local:${file}` : file;
let host;
let diagnostics = "";
async function stopHost() {
  if (host && host.exitCode === null && host.signalCode === null) {
    const exited = once(host, "exit");
    host.kill("SIGTERM");
    const timeout = setTimeout(() => host.kill("SIGKILL"), 10_000);
    await exited; clearTimeout(timeout);
  }
}
try {
  await mkdir(knowledge); await mkdir(project);
  await mkdir(join(knowledge, ".lake/packages/mathlib"), { recursive: true });
  await writeFile(join(knowledge, ".lake/packages/mathlib/README.md"), "@@todo [Do not index dependencies]");
  await writeFile(join(knowledge, "proof.md"), "#+begin theorem\n@@todo [Native proof]{id: abc123, sche: 2026-09-15 10:00, prio: A}\n#+end\n");
  const examples = "```md\n@@todo [Fenced example]\n```\n\n`@@todo [Inline example]`\n\n    @@todo [Indented example]\n";
  await writeFile(join(knowledge, "examples.md"), examples);
  await writeFile(join(project, "examples.md"), examples);
  const unclosed = "# Capture\n\n```md\nexample";
  await writeFile(join(knowledge, "unclosed.md"), unclosed);
  await writeFile(join(project, "unclosed.md"), unclosed);
  const notebook = JSON.parse(await readFile(join(repository, "poc/org-agenda/example.noema"), "utf8"));
  const workFile = join(project, "work.noema");
  await writeFile(workFile, JSON.stringify(notebook));
  async function bootHost() {
    diagnostics = "";
    host = spawn(process.execPath, [join(repository, "web-host.mjs")], {
    cwd: repository, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NOEMA_ROOT: knowledge, AARONNOTE_ROOT: knowledge,
      AARONNOTE_HOST_MODE: "emacs", AARONNOTE_STATE_DIR: join(temporary, "state"),
      AARONNOTE_TMP_DIR: join(temporary, "tmp"), AARONNOTE_RUNTIME_ROOT: repository,
      AARONNOTE_WEB_PORT: "0",
      AARONNOTE_EMACS_GATEWAY_URL: process.env.NOEMA_AGENDA_GATEWAY_TEST_URL || "",
      AARONNOTE_EMACS_GATEWAY_BINDING: process.env.NOEMA_AGENDA_GATEWAY_TEST_BINDING || "",
      NOEMA_KERNEL_BASE: "", NOEMA_KERNEL_DISABLED: "0",
      NOEMA_KERNEL_WORKSPACE: join(temporary, "kernel-workspace"), NOEMA_KERNEL_CONFIG_DIR: join(temporary, "kernel-config") },
  });
    return new Promise((ready, reject) => {
    const timeout = setTimeout(() => reject(new Error("Host startup timed out")), 60_000);
    const listen = (data) => {
      diagnostics = (diagnostics + data.toString()).slice(-12000);
      const match = diagnostics.match(/\[aaronnote-web\] (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); ready(match[1]); }
    };
    host.stdout.on("data", listen); host.stderr.on("data", listen);
    host.once("error", (error) => { clearTimeout(timeout); reject(error); });
    host.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Host exited: ${code}`)); });
  });
  }
  let url = await bootHost();
  async function api(operation, body = {}, group = "agenda") {
    const response = await fetch(`${url}/api`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: `aaronnote:api:${group}:${operation}`, args: [body] }),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  const initial = await api("query", { from: "2026-09-15" });
  assert.equal(initial.evaluationSource, "kernel-agenda");
  assert.equal(initial.todos.length, 1);
  assert.deepEqual(initial.errors, []);
  const beforeDocument = await api("status");
  const editorText = "😀\n@@itodo [Unsaved]{sche: 2026-09-20}\n\n```md\n@@todo [Example]\n```";
  const editorSnapshot = await api("document", {file:"/fs:never-entered:/project/unsaved.md",content:editorText});
  assert.deepEqual(editorSnapshot.todos.map(todo=>todo.text), ["Unsaved"]);
  assert.equal(editorSnapshot.todos[0].index, 3);
  assert.equal(editorSnapshot.todos[0].sourceRef, undefined);
  assert.deepEqual(await api("status"), beforeDocument);
  assert.equal((await api("query-active")).todos.length, 1);
  const scope = await api("enter", { root: identity(project), lease: "smoke" });
  const snapshot = await api("query", { scopes: ["knowledge", scope.id], from: "2026-09-15" });
  assert.equal(snapshot.todos.length, 4);
  assert.deepEqual(snapshot.errors, []);
  for (const [scopeId, root] of [["knowledge", knowledge], [scope.id, project]]) {
    const rejected = await fetch(`${url}/api`, {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({channel:"aaronnote:api:agenda:capture",args:[{scopeId,file:"unclosed.md",text:"Must remain visible"}]}),
      signal: AbortSignal.timeout(30_000),
    });
    const detail = await rejected.text();
    assert(rejected.status >= 400, detail);
    assert.match(detail, /literal|code block/i);
    assert.equal(await readFile(join(root,"unclosed.md"),"utf8"), unclosed);
    assert.equal(await readFile(join(root,"examples.md"),"utf8"), examples);
  }
  const work = snapshot.todos.find((item) => item.workNodeId === "wn_proof");
  assert(work);
  const knowledgeIndexVersion = (await api("roam-index", {}, "notes")).indexVersion;
  assert.equal(typeof knowledgeIndexVersion, "number");
  await api("patch", { scopeId: scope.id, uid: work.uid, revision: work.sourceRef.revision, patch: { op: "complete" } });
  assert.equal((await api("roam-index", {}, "notes")).indexVersion, knowledgeIndexVersion,
    "Project writes must not invalidate the knowledge index");
  const disk = JSON.parse(await readFile(workFile, "utf8"));
  assert.deepEqual(disk.cells, notebook.cells);
  assert.deepEqual(disk.metadata.noema_research.dependencies, notebook.metadata.noema_research.dependencies);
  assert.equal(disk.metadata.noema_research.work_nodes.find((node) => node.id === "wn_proof").state, "done");
  const md = initial.todos[0];
  await api("patch", { scopeId: "knowledge", uid: md.uid, revision: md.sourceRef.revision, patch: { op: "complete" } });
  assert.match(await readFile(join(knowledge, "proof.md"), "utf8"), /@@todo\(done\)/);
  // The existing Web channel uses the same active scopes and native UIDs.
  const web = await api("agenda", { includePlanning: true, includeGantt: true }, "notes");
  assert.equal(web.todos.length, 4);
  assert(web.todos.every((todo) => todo.id === todo.uid));
  for (const task of web.gantt.tasks) assert.equal(task.id, task.source.uid);
  const captured = await api("create-todo", { scopeId: scope.id, text: "Project capture", sche: "2026-09-15" }, "notes");
  assert.equal(captured.todo.id, captured.todo.uid);
  const capturedAgain = await api("capture", { scopeId: scope.id, text: "Second capture" });
  const tasks = (await api("query", { scopes: [scope.id] })).todos.filter((todo) => todo.sourceKind === "markdown");
  const locator = (todo) => ({ uid: todo.uid, scopeId: todo.scopeId, revision: todo.sourceRef.revision });
  const batch = await api("batch", { items: tasks.map(locator), patch: { op: "complete" } });
  assert.equal(batch.succeeded, 2, JSON.stringify(batch));
  const clockTask = (await api("query", { scopes: [scope.id] })).todos.find((todo) => todo.uid === captured.todo.uid);
  await api("clock-in", locator(clockTask), "notes");
  const clockView = await api("agenda", { includePlanning: true }, "notes");
  assert.equal(clockView.clocktable.running.scopeId, scope.id);
  await api("clock-out", clockView.clocktable.running, "notes");
  assert.equal((await api("agenda", { includePlanning: true }, "notes")).clocktable.running, null);
  const afterClock = (await api("query", { scopes: [scope.id] })).todos;
  await api("dependency", {
    source: locator(afterClock.find((todo) => todo.uid === captured.todo.uid)),
    target: locator(afterClock.find((todo) => todo.uid === capturedAgain.todo.uid)),
  });
  assert.equal((await api("query", { scopes: [scope.id] })).todos.find((todo) => todo.uid === captured.todo.uid).deps[0], capturedAgain.todo.uid);
  const emacs = await promisify(execFile)(process.env.EMACS || "emacs", ["--batch", "-Q", "-L", join(repository, "lisp"),
    "-l", join(repository, "scripts/check-native-agenda-actions.el")], {
    cwd: repository, timeout: 120_000,
    env: { ...process.env, NOEMA_AGENDA_TEST_URL: url, NOEMA_AGENDA_TEST_SCOPE: scope.id },
  });
  assert.match(emacs.stdout, /Native Emacs capture.*passed/);
  const emacsRoot = resolve(repository, "../..");
  const roam = await promisify(execFile)(process.env.EMACS || "emacs", ["--batch", "--no-site-file", "--no-site-lisp", "-q",
    `--init-directory=${emacsRoot}`, "-l", join(emacsRoot,"early-init.el"), "-l", join(emacsRoot,"init.el"),
    "-l", join(repository,"scripts/check-roam-agenda-actions.el")], {
    cwd:emacsRoot, timeout:120_000, env:{...process.env, NOEMA_AGENDA_TEST_URL:url, NOEMA_AGENDA_TEST_SCOPE:scope.id},
  });
  assert.match(roam.stdout, /Roam snapshot\/native writes\/repeat: passed/);
  const nativeTemplateTask=(await api("query",{scopes:[scope.id]})).todos.find(todo=>todo.text==='Native template capture');
  assert(nativeTemplateTask);
  assert.equal(nativeTemplateTask.canon.ddl,'2026-09-25');assert.equal(nativeTemplateTask.canon.prio,'B');
  const catalog=await api('capture-templates');
  const templated=await api('capture',{scopeId:scope.id,templateId:'event',templateRevision:catalog.revision,
    text:'Template appointment',sche:'2026-09-25 10:00',end:'2026-09-25 11:00'});
  assert.equal(templated.todo.canon.end,'2026-09-25 11:00');
  const afterEmacs = JSON.parse(await readFile(workFile, "utf8"));
  assert.deepEqual(afterEmacs.cells, disk.cells);
  assert.deepEqual(afterEmacs.metadata.noema_research.dependencies, disk.metadata.noema_research.dependencies);
  for (const id of ["wn_alternative", "wn_review"]) {
    const node = afterEmacs.metadata.noema_research.work_nodes.find((node) => node.id === id);
    const before = disk.metadata.noema_research.work_nodes.find((node) => node.id === id);
    assert.equal(node.state, before.state);
    assert.equal(node.outcome, before.outcome);
    assert.equal(node.agenda.clocks.length, 1);
    assert(node.agenda.clocks[0].to);
  }
  const afterWorkClocks = await api("agenda", { includePlanning: true, includeGantt: true }, "notes");
  const alternative = afterWorkClocks.todos.find((todo) => todo.workNodeId === "wn_alternative");
  assert.equal(alternative.canon.progress, "37.5");
  assert.equal([...afterWorkClocks.gantt.tasks, ...afterWorkClocks.gantt.backlog].find((task) => task.id === alternative.uid).progress, 37.5);
  assert(afterWorkClocks.clocks.filter((clock) => clock.sourceKind === "work-node").every((clock) => clock.todoId));
  await api("clock-in", locator(alternative));
  let attention;
  if(process.env.NOEMA_AGENDA_APPLE_TEST === "1") {
    const capture=await api("capture",{scopeId:scope.id,file:"attention.md",text:"手机任务",sche:"2026-09-16 10:00",end:"2026-09-16 11:00"});
    const task=(await api("query",{scopes:[scope.id]})).todos.find(todo=>todo.uid===capture.todo.uid);
    attention=await api("attention-promote",{...locator(task),kind:"reminder",calendarId:"disposable",timeZone:"Australia/Sydney"});
    assert.equal(attention.status,"synced",JSON.stringify(attention));
    await api("attention-promote",{...locator(task),kind:"event",calendarId:"disposable",timeZone:"Australia/Sydney"});
    assert.equal((await api("attention")).items.length,2);
  }
  await api("leave", { id: scope.id, lease: "smoke" });
  // Remove access to the inactive path. The host may only touch its journal.
  const away = `${project}-away`;
  await rename(project, away);
  if(attention) {
    const endpoint=process.env.NOEMA_AGENDA_GATEWAY_TEST_URL.replace(/^ws:/,"http:").replace(/\/ws$/,"/rpc");
    const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"phone-edit",method:"emacs.eval",
      params:{source:`(agenda-smoke-apple-edit "${attention.id}" '((completed . t) (title . "手机完成 🚀")))`}})});
    const receipt=await response.json();assert(!receipt.error,JSON.stringify(receipt));
    const pending=await api("attention-sync",{id:attention.id});
    assert.equal(pending.items.find(item=>item.id===attention.id).status,"pending-source");
  }
  const inactiveClock = (await api("agenda", { includePlanning: true }, "notes")).clocktable.running;
  assert.equal(inactiveClock.inactive, true);
  assert.equal((await api("clock-out", inactiveClock)).deferred, true);
  const stopReceipt = (await api("query", { includePlanning: true })).clocktable.pendingWrites[0];
  assert(stopReceipt.to);
  await stopHost();
  url = await bootHost();
  const resumed = await api("query", { includePlanning: true });
  assert.deepEqual(resumed.errors, []);
  assert.equal(resumed.clocktable.pendingWrites[0].to, stopReceipt.to);
  assert.equal((await api("status")).scopes.length, 1);
  await rename(away, project);
  const reentered = await api("enter", { root: identity(project), lease: "smoke-reentered" });
  assert.deepEqual(reentered.changedPaths, [identity(workFile)]);
  const durableDisk = JSON.parse(await readFile(workFile, "utf8"));
  assert.equal(durableDisk.metadata.noema_research.work_nodes.find((node) => node.id === "wn_alternative").agenda.clocks.at(-1).to, stopReceipt.to);
  assert.deepEqual(durableDisk.cells, afterEmacs.cells);
  assert.deepEqual(durableDisk.metadata.noema_research.dependencies, afterEmacs.metadata.noema_research.dependencies);
  assert.deepEqual((await api("query", { includePlanning: true })).clocktable.pendingWrites, []);
  if(attention) {
    const synced=await api("attention-sync",{id:attention.id});
    assert.equal(synced.items.find(item=>item.id===attention.id).status,"synced",JSON.stringify(synced));
    const source=await readFile(join(project,"attention.md"),"utf8");
    assert.match(source,/@@todo\(done\)/);assert.match(source,/手机完成 🚀/);
    await api("attention-remove",{id:attention.id});
    assert.equal((await api("attention")).items.length,1);
    assert.equal(await readFile(join(project,"attention.md"),"utf8"),source);
  }
  await api("leave", { id: reentered.id, lease: "smoke-reentered" });
  const status = await api("status");
  assert.equal(status.scopes.length, 1);
  assert.equal(status.owners.length, 1);
  assert.equal((await api("query")).todos.length, 1);
  // The registered knowledge box uses Go source mutations. Completing the
  // first item changes its length; the second must rebase on the true new hash.
  await api("capture", { file: "batch-proof.md", text: "第一步 🚀" });
  await api("capture", { file: "batch-proof.md", text: "第二步 🚀" });
  const knowledgeBatchTasks = (await api("query")).todos.filter((todo) => todo.file === join(knowledge, "batch-proof.md"));
  assert.equal(knowledgeBatchTasks.length, 2);
  const knowledgeBatch = await api("batch", { items: knowledgeBatchTasks.map(locator), patch: { op: "complete" } });
  assert.equal(knowledgeBatch.succeeded, 2, JSON.stringify(knowledgeBatch));
  assert.equal((await readFile(join(knowledge, "batch-proof.md"), "utf8")).match(/@@todo\(done\)/g)?.length, 2);
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(snapshot));
  process.stdout.write(JSON.stringify({ ok: true, routedSource: routed, durableAttention:!!attention, evaluation: initial.evaluationSource, nativeTasks: snapshot.todos.length,
    captureTemplates: true, nativeSourceNavigation: true, roamSnapshotAndWrites: true, literalSources: true, rejectedLiteralCapture: true, markdownWrite: true, workNodeWrite: true, workNodeClockProgress: true, durableClock: true, preservedDAG: true, webScopes: true, scopedCapture: true, scopedBatch: true, knowledgeBatch: true, scopedClock: true, scopedDependency: true, nativeEmacsActions: true, inactiveProjectReleased: true }) + "\n");
} catch (error) {
  process.stderr.write(`${diagnostics}\n${error.stack || error}\n`);
  process.exitCode = 1;
} finally {
  await stopHost();
  await rm(temporary, { recursive: true, force: true });
}
