#!/usr/bin/env bun

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import { loadConfig } from '../../apps/account-free-intake/src/config.js';

const CONFIG_FILE = '/run/account-free-intake/account-free-intake.json';
const TIMEOUT_MS = 2_000;

async function verifyConfigFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (typeof process.getgid === 'function' && metadata.gid !== process.getgid())
    ) throw new Error('invalid active config');
  } finally {
    await handle?.close();
  }
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/healthz',
      method: 'GET',
      headers: { Host: `127.0.0.1:${port}` },
      timeout: TIMEOUT_MS,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200 || body !== '{"status":"ok"}\n') {
          reject(new Error('intake health response was not ready'));
        } else resolve();
      });
    });
    request.once('timeout', () => request.destroy(new Error('intake health timeout')));
    request.once('error', reject);
    request.end();
  });
}

export async function checkIntakeHealth({ configFile = CONFIG_FILE } = {}) {
  await verifyConfigFile(configFile);
  const config = await loadConfig(configFile);
  await requestHealth(config.listen.port);
}

if (import.meta.main) {
  try {
    await checkIntakeHealth();
  } catch {
    process.exit(1);
  }
}
