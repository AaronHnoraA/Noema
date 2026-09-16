/** EventKit protocol smoke: no authorization request and no personal data IO. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const helper = spawn(fileURLToPath(new URL('../build/apple/noema-agenda-eventkit', import.meta.url)), [], {stdio:['pipe','pipe','inherit']});
const pending = new Map();
let sequence = 0;
const lines = createInterface({input:helper.stdout});
const ready = new Promise((resolve) => {
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.event === 'ready') resolve(message);
    const callback = pending.get(message.id);
    if (callback) {pending.delete(message.id);callback.resolve(message);}
  });
});
const deadline = setTimeout(() => {helper.kill('SIGKILL');}, 20_000);
helper.once('exit', () => {
  for (const callback of pending.values()) callback.reject(new Error('Helper exited with a pending request'));
  pending.clear();
});
async function request(body) {
  const id = ++sequence;
  const result = new Promise((resolve,reject) => pending.set(id,{resolve,reject}));
  helper.stdin.write(JSON.stringify({...body,id})+'\n');
  return result;
}
try {
  await Promise.race([ready,once(helper,'exit').then(() => {throw new Error('Helper exited before ready');})]);
  const status = await request({op:'status'});
  assert.equal(status.result.protocol,1);
  assert.equal(typeof status.result.reminder,'number');
  assert.equal(typeof status.result.event,'number');
  // Invalid kinds must fail validation before the EventKit permission API.
  assert.equal((await request({op:'authorize',kind:'invalid'})).error.code,'EINVAL');
  const exited = once(helper,'exit');
  helper.stdin.end();
  assert.equal((await exited)[0],0);
  process.stdout.write(JSON.stringify({ok:true,protocol:true,explicitAuthorization:true,personalDataRead:false})+'\n');
} finally {
  clearTimeout(deadline); lines.close();
  if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGTERM');
}
