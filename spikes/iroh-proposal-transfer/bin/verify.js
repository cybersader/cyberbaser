#!/usr/bin/env bun

import { stableStringify } from '../src/contracts.js';
import { runIrohVerification } from '../src/verification.js';

const report = await runIrohVerification();
process.stdout.write(stableStringify(report));
process.exitCode = report.complete ? 0 : 1;
