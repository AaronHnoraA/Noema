/** Real Emacs WebSocket gateway + Remote source process + host + Go + UI actions.
 * Logical local target exercises the transport, not an SSH parity claim. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = await mkdtemp(join(tmpdir(), 'noema-source-gateway-'));
let gateway, check, diagnostics = '';
async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  process.kill('SIGTERM');
  const timeout = setTimeout(() => process.kill('SIGKILL'), 10_000);
  try { await exited; } finally { clearTimeout(timeout); }
}
try {
  gateway = spawn(process.env.EMACS || 'emacs', ['--batch', '-Q', '-l', join(repository, 'scripts/check-agenda-source-gateway.el')], {
    cwd: repository, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, NOEMA_AGENDA_EMACS_ROOT: resolve(repository, '../..'), NOEMA_AGENDA_GATEWAY_TEST_STATE: state},
  });
  const connection = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Gateway startup timed out')), 30_000);
    const listen = (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-16000);
      const match = diagnostics.match(/AGENDA_GATEWAY_READY (.+)\n/);
      if (match) { clearTimeout(timeout); resolve(JSON.parse(match[1])); }
    };
    gateway.stdout.on('data', listen); gateway.stderr.on('data', listen);
    gateway.once('error', (error) => { clearTimeout(timeout); reject(error); });
    gateway.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Gateway exited: ${code}`)); });
  });
  check = spawn(process.execPath, [join(repository, 'scripts/check-native-agenda.mjs')], {
    cwd: repository, stdio: 'inherit', env: {...process.env, NOEMA_AGENDA_ROUTED_TEST: '1',
      NOEMA_AGENDA_APPLE_TEST:'1',
      NOEMA_AGENDA_GATEWAY_TEST_URL: connection.url, NOEMA_AGENDA_GATEWAY_TEST_BINDING: connection.binding},
  });
  const [code] = await once(check, 'exit');
  if (code !== 0) throw new Error(`Routed Agenda check exited: ${code}`);
} catch (error) {
  process.stderr.write(`${diagnostics}\n${error.stack}\n`);
  process.exitCode = 1;
} finally {
  await stop(check); await stop(gateway);
  await rm(state, {recursive:true,force:true});
}
