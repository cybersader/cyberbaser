#!/usr/bin/env bun

import { adversarialVerificationJson } from '../src/adversarial-verification.js';

const json = await adversarialVerificationJson();
process.stdout.write(json);
const report = JSON.parse(json);
process.exitCode = report.complete ? 0 : 1;
