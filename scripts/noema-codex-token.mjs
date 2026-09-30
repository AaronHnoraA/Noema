// Pi's credential command reads the current Codex CLI access token on demand.
// Noema never writes the token into its own configuration or project files.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const authPath = process.argv[2] ?? join(homedir(), '.codex', 'auth.json');
try {
  const auth = JSON.parse(readFileSync(authPath, 'utf8'));
  const token = auth?.auth_mode === 'chatgpt' && auth?.tokens?.access_token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Codex CLI login has no access token');
  }
  process.stdout.write(token);
} catch (error) {
  process.stderr.write(`Noema Pi Codex login: ${error.message}\n`);
  process.exitCode = 1;
}
