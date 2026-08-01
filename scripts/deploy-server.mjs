import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { normalizeServerDeployConfig, normalizeServerRuntimeConfig } from "../server/lib/server-config.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const deployFile = resolve(process.argv[2] || process.env.NOEMA_SERVER_DEPLOY_CONFIG || join(projectRoot, "server-config", "deploy.json"));
const runtimeFile = resolve(process.env.NOEMA_SERVER_CONFIG || join(dirname(deployFile), "runtime.json"));
const releaseRoot = join(projectRoot, "build", "server");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function run(command, args, options = {}) {
  process.stdout.write(`+ ${command} ${args.map(shellQuote).join(" ")}\n`);
  return await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 32, ...options });
}

async function ssh(config, script, options = {}) {
  return await run("ssh", [config.sshTarget, script], options);
}

function remoteCommand(command, args = []) {
  return [command, ...args.map(shellQuote)].join(" ");
}

function releaseCleanupProgram(remoteRoot, retainReleases) {
  const releasesDir = join(remoteRoot, "releases");
  const currentLink = join(remoteRoot, "current");
  return `(async()=>{
    const {readdir,readlink,rm}=require('node:fs/promises');
    const {basename,resolve}=require('node:path');
    const releasesDir=${JSON.stringify(releasesDir)};
    const currentLink=${JSON.stringify(currentLink)};
    const retain=${retainReleases};
    const current=basename(await readlink(currentLink));
    const entries=(await readdir(releasesDir,{withFileTypes:true}))
      .filter((entry)=>entry.isDirectory()&&/^\\d{8}T\\d{6}Z-\\d+$/.test(entry.name))
      .map((entry)=>entry.name).sort().reverse();
    const keep=new Set([current]);
    for(const name of entries){if(keep.size>=retain)break;keep.add(name)}
    const pruned=[];
    for(const name of entries){
      if(keep.has(name))continue;
      const target=resolve(releasesDir,name);
      if(!target.startsWith(resolve(releasesDir)+'/'))throw new Error('unsafe release path');
      await rm(target,{recursive:true,force:false});
      pruned.push(name);
    }
    console.log(JSON.stringify({retained:entries.filter((name)=>keep.has(name)),pruned}));
  })()`;
}

const deploy = normalizeServerDeployConfig(JSON.parse(await readFile(deployFile, "utf8")));
const runtimeRaw = JSON.parse(await readFile(runtimeFile, "utf8"));
const runtime = normalizeServerRuntimeConfig(runtimeRaw, { configFile: runtimeFile });
const releaseId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")}-${process.pid}`;
const releaseDir = join(deploy.remoteRoot, "releases", releaseId);
const currentDir = join(deploy.remoteRoot, "current");
const remoteConfigDir = join(deploy.remoteRoot, "server-config");
const remoteRuntime = join(remoteConfigDir, "runtime.json");
const remoteUnit = join(remoteConfigDir, deploy.serviceName);
const temporary = await mkdtemp(join(tmpdir(), "noema-server-deploy-"));
let previousRelease = "";

const unit = `[Unit]
Description=Noema read-only Markdown server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${currentDir}
Environment=AARONNOTE_HOST_MODE=server
Environment=NOEMA_SERVER_CONFIG=${remoteRuntime}
Environment=AARONNOTE_RUNTIME_ROOT=${currentDir}
Environment=AARONNOTE_WEB_DIR=${join(currentDir, "dist", "aaronnote")}
ExecStart=${deploy.nodeBin} ${join(currentDir, "web-host.mjs")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

try {
  const unitFile = join(temporary, deploy.serviceName);
  await writeFile(unitFile, unit, { encoding: "utf8", mode: 0o600 });
  const previous = await ssh(deploy, `${remoteCommand("readlink", [currentDir])} 2>/dev/null || true`);
  previousRelease = String(previous.stdout || "").trim();
  await ssh(deploy, remoteCommand("mkdir", ["-p", releaseDir, remoteConfigDir]));
  await run("rsync", ["-az", "--delete", `${releaseRoot}/`, `${deploy.sshTarget}:${releaseDir}/`]);
  await run("rsync", ["-az", runtimeFile, `${deploy.sshTarget}:${remoteRuntime}`]);
  await run("rsync", ["-az", unitFile, `${deploy.sshTarget}:${remoteUnit}`]);
  await ssh(deploy, `${remoteCommand("cd", [releaseDir])} && ${remoteCommand(deploy.npmBin, ["ci", "--omit=dev"])}`);
  await ssh(deploy, [
    remoteCommand("ln", ["-sfn", releaseDir, currentDir]),
    remoteCommand("systemctl", ["--user", "link", remoteUnit]),
    remoteCommand("systemctl", ["--user", "daemon-reload"]),
    remoteCommand("systemctl", ["--user", "enable", "--now", deploy.serviceName]),
    remoteCommand("systemctl", ["--user", "restart", deploy.serviceName]),
  ].join(" && "));
  const healthHost = runtime.listen.host === "0.0.0.0" || runtime.listen.host === "::"
    ? "127.0.0.1"
    : runtime.listen.host;
  const healthProgram = `(async()=>{let last;for(let i=0;i<20;i++){try{const r=await fetch('http://${healthHost}:${runtime.listen.port}/health');const j=await r.json();if(r.ok&&j.hostMode==='server'&&j.ok){console.log(JSON.stringify(j));return}last=new Error(JSON.stringify(j))}catch(e){last=e}await new Promise(r=>setTimeout(r,500))}throw last||new Error('health timeout')})()`;
  await ssh(deploy, `${remoteCommand(deploy.nodeBin, ["-e", healthProgram])}`, { timeout: 30_000 });
  const cleanup = await ssh(deploy, remoteCommand(deploy.nodeBin, [
    "-e",
    releaseCleanupProgram(deploy.remoteRoot, deploy.retainReleases),
  ]));
  process.stdout.write(`Release retention: ${String(cleanup.stdout || "").trim()}\n`);
  process.stdout.write(`Deployed ${releaseId} and verified Server mode health.\n`);
} catch (error) {
  if (previousRelease) {
    process.stderr.write(`Deployment failed; restoring ${previousRelease}.\n`);
    await ssh(deploy, `${remoteCommand("ln", ["-sfn", previousRelease, currentDir])} && ${remoteCommand("systemctl", ["--user", "restart", deploy.serviceName])}`).catch(() => {});
  }
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
