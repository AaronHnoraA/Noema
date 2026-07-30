#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function argValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && index + 1 < args.length) values.push(args[++index]);
  }
  return values;
}

function hasArg(args, name) {
  return args.includes(name);
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const action = args[0] || "index";
  const root = resolve(argValue(args, "--root", process.env.AARONNOTE_ROOT || process.cwd()));
  const workspaceRoot = resolve(argValue(
    args,
    "--workspace",
    process.env.AARONNOTE_WORKSPACE_ROOT || resolve(scriptDir, "..", "..", ".."),
  ));
  const runtimeRoot = resolve(argValue(
    args,
    "--runtime",
    process.env.AARONNOTE_RUNTIME_ROOT || scriptDir,
  ));
  const stateRoot = resolve(argValue(
    args,
    "--state",
    process.env.AARONNOTE_STATE_DIR || resolve(workspaceRoot, "var", "aaronnote"),
  ));
  const tmpRoot = resolve(argValue(
    args,
    "--tmp",
    process.env.AARONNOTE_TMP_DIR || resolve(stateRoot, "tmp"),
  ));
  const templatesRoot = resolve(argValue(
    args,
    "--templates",
    process.env.AARONNOTE_TEMPLATES_ROOT || resolve(workspaceRoot, "templates", "noema"),
  ));
  const runtimeUrl = pathToFileURL(resolve(runtimeRoot, "server/lib/index.mjs")).href;
  const runtime = await import(runtimeUrl);

  runtime.configure({
    root,
    workspaceRoot,
    stateRoot,
    tmpRoot,
    templatesRoot,
  });

  let result;
  if (action === "index") {
    result = await runtime.notesIndexPayload();
  } else if (action === "graph") {
    result = runtime.graphPayload(await runtime.scanNotes());
  } else if (action === "tags") {
    result = runtime.tagIndexPayload(await runtime.scanNotes());
  } else if (action === "todos") {
    result = await runtime.getTodos({
      file: argValue(args, "--file", ""),
    });
  } else if (action === "update-todo") {
    result = await runtime.updateTodoStatus(JSON.parse(argValue(args, "--json", "{}")));
  } else if (action === "agenda") {
    result = await runtime.buildAgenda(JSON.parse(argValue(args, "--json", "{}")));
  } else if (action === "create-todo") {
    result = await runtime.createTodo(JSON.parse(argValue(args, "--json", "{}")));
  } else if (action === "patch-todo") {
    result = await runtime.patchTodo(JSON.parse(argValue(args, "--json", "{}")));
  } else if (action === "todo-dep-ref") {
    const body = JSON.parse(argValue(args, "--json", "{}"));
    const { todos } = await runtime.getTodos("");
    const target = todos.find((todo) => todo.id === body.targetId);
    if (!target) throw new Error("Todo not found");
    const source = body.sourceId ? todos.find((todo) => todo.id === body.sourceId) || null : null;
    const scope = todos.filter((todo) => todo.file === target.file);
    result = { type: "todo-dep-ref", ref: runtime.depRefForTodo(target, scope, source) };
  } else if (action === "templates") {
    result = {
      templates: await runtime.scanTemplates({ force: hasArg(args, "--force") }),
    };
  } else if (action === "create") {
    result = await runtime.createNode(JSON.parse(argValue(args, "--json", "{}")));
  } else if (action === "delete-node") {
    const body = JSON.parse(argValue(args, "--json", "{}"));
    const file = argValue(args, "--file", argValue(args, "--path", ""));
    result = await runtime.deleteNote(file ? { ...body, file } : body);
  } else if (action === "sync") {
    const notes = await runtime.syncRoamDb(null, {
      mode: hasArg(args, "--full") ? "full" : "auto",
      changedFiles: argValues(args, "--changed"),
    });
    result = { ok: true, noteCount: Array.isArray(notes) ? notes.length : 0 };
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
