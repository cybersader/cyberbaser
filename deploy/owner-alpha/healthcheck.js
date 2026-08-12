#!/usr/bin/env bun

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import { loadOwnerAlphaConfig } from '../../apps/owner-alpha/src/config.js';

const CONFIG_FILE = '/run/owner-alpha/owner-alpha.local.json';
const EXPECTED_READY_FILE = '/run/owner-alpha/ready';
const READY_CONTENT = 'owner-alpha-ready-v1\n';
const TIMEOUT_MS = 2_000;

async function verifyReady(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile()
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (typeof process.getgid === 'function' && metadata.gid !== process.getgid())) {
      throw new Error('invalid ready marker');
    }
    if (await handle.readFile('utf8') !== READY_CONTENT) throw new Error('invalid ready marker');
  } finally {
    await handle?.close();
  }
}

function requestReader(config) {
  const expectedHost = `${config.listen.host}:${config.listen.readerPort}`;
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: config.listen.host,
      port: config.listen.readerPort,
      path: '/cyberbase/',
      method: 'GET',
      headers: { Host: expectedHost },
      timeout: TIMEOUT_MS,
      agent: false,
    }, (response) => {
      response.resume();
      response.once('end', () => {
        if (response.statusCode !== 200) reject(new Error('reader not ready'));
        else resolve();
      });
    });
    request.once('timeout', () => request.destroy(new Error('reader health timeout')));
    request.once('error', reject);
    request.end();
  });
}

export async function checkOwnerAlphaHealth({
  configFile = CONFIG_FILE,
  readyFile = process.env.OWNER_ALPHA_READY_FILE ?? EXPECTED_READY_FILE,
  enforceReadyContract = false,
} = {}) {
  if (enforceReadyContract && readyFile !== EXPECTED_READY_FILE) throw new Error('unexpected ready marker path');
  await verifyReady(readyFile);
  const config = await loadOwnerAlphaConfig(configFile);
  await requestReader(config);
}

if (import.meta.main) {
  try {
    await checkOwnerAlphaHealth({ enforceReadyContract: true });
  } catch {
    process.exit(1);
  }
}
