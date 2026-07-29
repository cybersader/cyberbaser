#!/usr/bin/env bun

import { syntheticVerificationJson } from '../src/verification.js';

const json = await syntheticVerificationJson();
process.stdout.write(json);
const report = JSON.parse(json);
process.exitCode = report.complete ? 0 : 1;
