import { spawn } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dir, 'fake-github.js');
export const FAKE_CLIENT_ID = 'Iv23liFAKEcyberbaser';

/** Start the fake GitHub in its own process; its tokens never enter this one. */
export async function startFakeGithub(reposRoot) {
  const child = spawn(process.execPath, [SCRIPT, reposRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /fake-github ready (\d+)\n/u.exec(out);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', (code) => reject(new Error(`fake GitHub exited ${code}: ${stderr}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  const control = async (route, body) => {
    const response = await fetch(`${origin}/_control/${route}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return response.json();
  };
  return {
    origin,
    port,
    scenario: (value) => control('scenario', value),
    addPat: (token, repository) => control('pat', { token, repository }),
    expireAccess: () => control('expire-access', {}),
    revokeAll: () => control('revoke', {}),
    report: () => control('report'),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}
