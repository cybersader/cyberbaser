#!/usr/bin/env bun

import path from 'node:path';

const DEPLOY = import.meta.dir;
const ROOT = path.resolve(DEPLOY, '../..');

export function validateCloudflaredImage(image) {
  if (typeof image !== 'string'
    || !/^cloudflare\/cloudflared@sha256:[a-f0-9]{64}$/u.test(image)
    || /^cloudflare\/cloudflared@sha256:0{64}$/u.test(image)) {
    throw new Error('CLOUDFLARED_IMAGE must be cloudflare/cloudflared@sha256:<64 verified hexadecimal digits>; replace the placeholder and load that exact image locally first');
  }
}

export function composeArguments(envFile) {
  if (typeof envFile !== 'string' || !path.isAbsolute(envFile)) {
    throw new Error('operator environment file must be an absolute path');
  }
  return [
    'compose',
    '--file', path.join(DEPLOY, 'compose.yaml'),
    '--file', path.join(DEPLOY, 'compose.public.yaml'),
    '--env-file', envFile,
    '--profile', 'public',
  ];
}

function run(args, capture = false) {
  const result = Bun.spawnSync({
    cmd: ['docker', ...args], cwd: ROOT,
    stdin: 'inherit', stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error(`docker compose failed (${result.exitCode})`);
  return capture ? result.stdout.toString() : '';
}

if (import.meta.main) {
  try {
    const [action, envFile, ...extra] = process.argv.slice(2);
    if (extra.length !== 0 || !['config', 'up', 'stop', 'down'].includes(action)) {
      throw new Error('usage: bun deploy/account-free-intake/public-profile.js <config|up|stop|down> /absolute/operator.env');
    }
    const args = composeArguments(envFile);
    // Cleanup remains possible even if an operator later unsets the image pin.
    if (action === 'config' || action === 'up') {
      const resolved = JSON.parse(run([...args, 'config', '--format', 'json'], true));
      validateCloudflaredImage(resolved.services?.cloudflared?.image);
    }
    if (action === 'config') run([...args, 'config']);
    else if (action === 'up') run([...args, 'up', '--detach', '--no-build', '--pull', 'never']);
    else if (action === 'stop') run([...args, 'stop', 'cloudflared']);
    else run([...args, 'down']); // Deliberately never --volumes.
  } catch (error) {
    process.stderr.write(`public intake profile: ${error.message}\n`);
    process.exitCode = 1;
  }
}
