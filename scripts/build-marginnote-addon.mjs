#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { connection } from "../plugins/marginnote/client.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const addon = join(root, "plugins/marginnote");
if (process.argv[2] === "--refresh-api") {
  const source = resolve(process.argv[3]);
  // Only API declarations; no upstream implementation is shipped.
  const script = String.raw`
import json,re,sys,subprocess
from pathlib import Path
root=Path(sys.argv[1]); interfaces=[]
aliases={'JSBMbBook':'Document','JSBMbBookNote':'Note','JSBMbTopic':'Notebook','JSBMbModelTool':'Database'}
for p in sorted((root/'API').rglob('*.h')):
 s=p.read_text(); s=re.sub(r'/\*.*?\*/','',s,flags=re.S); s=re.sub(r'//[^\n]*','',s)
 for match in re.finditer(r'@protocol\s*(\w+)\s*<[\s\S]*?@end',s):
  name=match.group(1)
  lines=[x.strip() for x in match.group(0).splitlines() if x.strip() and not x.lstrip().startswith('#')]
  interfaces.append({'name':name,'globals':[aliases.get(name,name.removeprefix('JSB'))],
   'path':str(p.relative_to(root)), 'declarations':'\n'.join(lines)})
revision=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
print(json.dumps({'source':'https://github.com/marginnoteapp/Addon','revision':revision,'interfaces':interfaces},ensure_ascii=False,indent=2))
`;
  const catalog = execFileSync("python3", ["-c", script, source], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  await writeFile(join(addon, "api-catalog.json"), catalog);
  const parsed = JSON.parse(catalog);
  process.stdout.write(`Indexed ${parsed.interfaces.length} native API interfaces at ${parsed.revision}\n`);
} else {
  const config = await connection();
  const out = join(root, "build/marginnote");
  await mkdir(out, { recursive: true });
  const target = join(out, "noema-agent.mnaddon");
  // Packaging through Python's stdlib keeps the native addon dependency-free.
  const script = String.raw`
import json,sys,zipfile
from pathlib import Path
source=Path(sys.argv[1]);target=Path(sys.argv[2]);config=json.loads(sys.stdin.read())
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
 for name in ['main.js','mnaddon.json']:z.write(source/name,name)
 z.writestr('connection.json',json.dumps(config))
 # Small neutral toolbar glyph, generated from PNG primitives (no asset dependency).
 import struct,zlib
 def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
 pixels=b''.join(b'\0'+b''.join(bytes((65,105,170,255 if (8<=x<=13 or 34<=x<=39 or abs(x-y)<3) and 8<=y<=39 else 0)) for x in range(48)) for y in range(48))
 png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',48,48,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
 z.writestr('icon.png',png)
`;
  execFileSync("python3", ["-c", script, addon, target], { input: JSON.stringify(config), stdio: ["pipe", "pipe", "pipe"] });
  await chmod(target, 0o600);
  const metadata = JSON.parse(await readFile(join(addon, "mnaddon.json"), "utf8"));
  process.stdout.write(`${target}\n${metadata.title} ${metadata.version}; connection configuration included privately\n`);
}
