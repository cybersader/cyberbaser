import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as pipeline from '../src/pipeline.js';
import { runCorpus } from '../src/corpus.js';

const fixtures = fileURLToPath(new URL('./fixtures/pr11', import.meta.url));
const cli = fileURLToPath(new URL('../bin/ofm-check.js', import.meta.url));

test('public regression corpus has no checker errors or leaks', () => {
  const report = runCorpus(fixtures);
  expect(report.n).toBe(6);
  expect(report.checkerErrors).toBe(0);
  expect(report.parseErrors).toBe(0);
  expect(report.maskLeaks).toBe(0);
});

test('corpus records lost content as checker errors, not successful normalization or parse failures', () => {
  const spy = spyOn(pipeline, 'roundtrip').mockImplementation(() => {
    throw new pipeline.RoundtripContentLossError('test loss');
  });
  try {
    const report = runCorpus(fixtures);
    expect(report.checkerErrors).toBe(6);
    expect(report.parseErrors).toBe(0);
    expect(report.byteOk).toBe(0);
    expect(report.normOk).toBe(0);
    expect(report.results.every((r) => r.err.startsWith('checker error:'))).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test('CLI describes inserted spacing instead of implying that the next sentence disappeared', () => {
  const source = readFileSync(new URL('./fixtures/pr11/after/📁 21 - Development/Software Factory for AI-Written Code.md', import.meta.url), 'utf8');
  const dir = mkdtempSync(fileURLToPath(new URL('./.cli-', import.meta.url)));
  const file = `${dir}/spacing.md`;
  // The excerpt alone is norm-equal. A later delimiter rewrite makes the CLI
  // display its earlier first divergence, as it does for the full real file.
  writeFileSync(file, source + '\n__Another paragraph__.\n');
  try {
    const result = spawnSync(process.execPath, [cli, 'roundtrip', file], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('serializer inserted a blank line; input text retained at output line 3');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('CLI corpus and roundtrip exit nonzero on refused input instead of passing', () => {
  const dir = mkdtempSync(fileURLToPath(new URL('./.cli-', import.meta.url)));
  const file = `${dir}/collision.md`;
  writeFileSync(file, 'A reserved sentinel  in the source.\n');
  try {
    const corpus = spawnSync(process.execPath, [cli, 'corpus', dir], { encoding: 'utf8' });
    expect(corpus.status).toBe(1);
    expect(corpus.stdout).toContain('mask collisions: 1');
    const diagnostic = spawnSync(process.execPath, [cli, 'roundtrip', file], { encoding: 'utf8' });
    expect(diagnostic.status).toBe(1);
    expect(diagnostic.stdout).toContain('ERROR');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
