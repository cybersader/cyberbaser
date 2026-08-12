#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import { stableStringify } from '../src/case.js';
import { parseStrictArgs } from '../src/cli.js';
import {
  initializeOwnerDogfoodSeries,
  recordPilotError,
} from '../src/pilot-workspace.js';

try {
  const options = parseStrictArgs(process.argv.slice(2), {
    allowed: ['input'],
    required: ['input'],
  });
  let charter;
  try {
    charter = JSON.parse(await readFile(options.input, 'utf8'));
  } catch {
    throw Object.assign(
      new Error('input must identify readable owner self-dogfood series JSON'),
      { code: 'invalid-series-input' },
    );
  }
  const result = await initializeOwnerDogfoodSeries({ charter });
  process.stdout.write(stableStringify(result));
} catch (error) {
  process.stderr.write(stableStringify(await recordPilotError({
    error,
    attemptScoped: false,
  })));
  process.exitCode = 1;
}
