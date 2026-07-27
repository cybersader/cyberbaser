#!/usr/bin/env bun

import { stableStringify } from '../src/contracts.js';
import { runFederationVerification } from '../src/verification.js';

const report = await runFederationVerification();
process.stdout.write(stableStringify(report));
process.exitCode = report.complete ? 0 : 1;
