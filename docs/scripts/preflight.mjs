#!/usr/bin/env bun
// Cross-platform preflight for docs/
//
// Why this exists: the repo gets used from both WSL (linux) and Windows
// PowerShell (win32). `bun install` writes platform-native binaries into
// node_modules/.bin (shell scripts on linux, .cmd/.ps1 on win32). When you
// switch sides without reinstalling, the `astro` binary looks "missing"
// because the other platform's stubs are sitting there.
//
// This script:
//   1. Detects current platform
//   2. Checks node_modules/.platform marker file
//   3. Reinstalls if: missing node_modules, missing astro binary, or
//      platform mismatch
//   4. Writes the marker so future runs can short-circuit
//
// Runs in ~20ms on the happy path. Reinstall path is as fast as bun install
// (cached, usually under 10 seconds after the first install on each side).

import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(here, '..');
const projectRoot = resolve(docsRoot, '..');
const focusFile = resolve(projectRoot, '.claude/FOCUS.md');
const logDirectory = resolve(docsRoot, 'src/content/docs/agent-context/zz-log');
const marker = resolve(docsRoot, 'node_modules/.platform');
const astroBinLinux = resolve(docsRoot, 'node_modules/.bin/astro');
const astroBinWin = resolve(docsRoot, 'node_modules/.bin/astro.cmd');

const currentPlatform = process.platform;
const gray = (s) => `\x1b[90m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function astroBinExistsForCurrentPlatform() {
  if (currentPlatform === 'win32') {
    return existsSync(astroBinWin);
  }
  if (!existsSync(astroBinLinux)) return false;
  // On linux, make sure it's an actual script (not a leftover windows stub)
  try {
    const firstBytes = readFileSync(astroBinLinux, { encoding: 'utf8', flag: 'r' }).slice(0, 2);
    return firstBytes === '#!' || firstBytes === '//';
  } catch {
    return false;
  }
}

function needsInstall() {
  if (!existsSync(resolve(docsRoot, 'node_modules'))) return 'no node_modules';
  if (!astroBinExistsForCurrentPlatform()) return `no astro binary for ${currentPlatform}`;
  if (!existsSync(marker)) return 'no platform marker (first run on this platform)';
  const recorded = readFileSync(marker, 'utf8').trim();
  if (recorded !== currentPlatform) return `platform changed (${recorded} → ${currentPlatform})`;
  return null;
}

function verifyKnowledgeOpsLog() {
  const focus = readFileSync(focusFile, 'utf8');
  const focusDate = focus.match(/^Last updated:\s*(\d{4}-\d{2}-\d{2})\b/m)?.[1];
  if (!focusDate) {
    console.error('✗ knowledge ops: .claude/FOCUS.md has no parseable Last updated date');
    process.exit(1);
  }
  const logDates = readdirSync(logDirectory)
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})-[a-z0-9-]+\.mdx$/u)?.[1])
    .filter(Boolean)
    .sort();
  const latestLogDate = logDates.at(-1);
  if (!latestLogDate || latestLogDate < focusDate) {
    console.error(`✗ knowledge ops: FOCUS is aligned ${focusDate}, but the newest dated zz-log is ${latestLogDate ?? 'missing'}`);
    console.error('  Add a dated docs/src/content/docs/agent-context/zz-log/YYYY-MM-DD-slug.mdx entry for the current work.');
    process.exit(1);
  }
  console.log(gray(`⦿ knowledge ops: zz-log ${latestLogDate} covers FOCUS ${focusDate}`));
}

const reason = needsInstall();
if (reason) {
  console.log(yellow(`⦿ preflight: ${reason} — running bun install`));
  const result = spawnSync('bun', ['install'], {
    cwd: docsRoot,
    stdio: 'inherit',
    shell: currentPlatform === 'win32',
  });
  if (result.status !== 0) {
    console.error('✗ bun install failed');
    process.exit(result.status ?? 1);
  }
  writeFileSync(marker, currentPlatform);
  console.log(green(`✓ preflight: installed for ${currentPlatform}`));
} else {
  console.log(gray(`⦿ preflight: ${currentPlatform} (cached)`));
}

verifyKnowledgeOpsLog();
