import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CSS = await readFile(path.join(import.meta.dir, '../public/review.css'), 'utf8');

function block(selector) {
  const at = CSS.indexOf(`${selector}{`);
  if (at < 0) throw new Error(`missing ${selector}`);
  return CSS.slice(at + selector.length + 1, CSS.indexOf('}', at));
}
const variable = (body, name) => new RegExp(`${name}:(#[0-9a-f]{6})`, 'u').exec(body)?.[1];
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('the decision panel follows the site colour scheme', () => {
  test('a dark site gets a dark panel with readable text', () => {
    const dark = block('body.rv-scheme-dark');
    for (const name of ['--sheet', '--field', '--hover', '--code-bg']) expect(luminance(variable(dark, name))).toBeLessThan(0.05);
    expect(contrast(variable(dark, '--ink'), variable(dark, '--sheet'))).toBeGreaterThan(7);
    expect(contrast(variable(dark, '--soft'), variable(dark, '--sheet'))).toBeGreaterThan(4.5);
    expect(contrast(variable(dark, '--ok'), variable(dark, '--sheet'))).toBeGreaterThan(4.5);
    expect(contrast(variable(dark, '--pri-ink'), variable(dark, '--pri-bg'))).toBeGreaterThan(4.5);
    expect(dark).toContain('color-scheme:dark');
    // The system scheme follows the device the same way.
    expect(CSS).toMatch(/@media \(prefers-color-scheme:dark\)\{body\.rv-scheme-system\{[^}]*--sheet:#1a211d/u);
  });

  test('panel surfaces use the scheme variables, not fixed light colours', () => {
    for (const selector of ['.rv-sheet', '.rv-sec', '.rv-pri', '.decision-reason', '.dialog-back', '#decision-confirm[data-action="reject"]',
      '#decision-confirm[data-action="approve"]', '.rv-list a:hover', '.rv-sec:hover']) {
      expect(block(selector)).not.toMatch(/#fff\b|#f[0-9a-f]{5}\b|#b9c1bb|#c9cfca/u);
    }
  });

  test('the light panel is unchanged', () => {
    const light = block('body.rv-doc');
    expect(variable(light, '--sheet')).toBeUndefined();
    expect(light).toContain('--sheet:#fff');
    expect(light).toContain('--field:#fff');
    expect(light).toContain('--pri-bg:#26302b');
  });
});
