#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { apiReference, call } from "./client.mjs";

try {
  const [command = "help", ...rest] = process.argv.slice(2);
  let result;
  if (command === "status") result = await call("/sessions");
  else if (command === "api") result = await apiReference(rest[0], Number(rest[1] || 0));
  else if (command === "result") result = await call("/requests/" + encodeURIComponent(rest[0]));
  else if (command === "exec") {
    const file = rest[0];
    if (!file) throw new Error("Usage: cli.mjs exec CODE.js|- [ARGS.json] [SESSION_ID]");
    const code = await readFile(file === "-" ? "/dev/stdin" : file, "utf8");
    const args = rest[1] ? JSON.parse(await readFile(rest[1], "utf8")) : {};
    result = await call("/execute", { code, args, sessionId: rest[2] });
    if (!result.ok) process.exitCode = 1;
  } else result = { usage: ["status", "api [QUERY] [OFFSET]", "exec CODE.js|- [ARGS.json] [SESSION_ID]", "result REQUEST_ID"],
    code: "JavaScript function body; return JSON, await supported. Native JSB globals plus app, db, window, study, reader, notebook, args, bridge, console." };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) { process.stderr.write(String(error.message || error) + "\n"); process.exitCode = 1; }
