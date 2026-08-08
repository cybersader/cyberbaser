import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { formatBootstrapUrl, startBootstrapConsole } from '../src/bootstrap-console.js';

const ORIGIN = 'http://100.100.100.100:4317';
const TOKEN = 'k'.repeat(43);

function consoleFixture(issueBootstrap) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString('utf8'); });
  const dispose = startBootstrapConsole({
    input,
    output,
    ownerOrigin: ORIGIN,
    issueBootstrap,
  });
  return {
    input,
    dispose,
    text: () => written,
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('bootstrap console', () => {
  test('formats the exact one-time bootstrap URL', () => {
    expect(formatBootstrapUrl(ORIGIN, TOKEN)).toBe(`${ORIGIN}/owner/bootstrap?token=${TOKEN}`);
  });

  test("issues exactly one capability per 'b' line and prints its private-address URL", async () => {
    let issued = 0;
    const fixture = consoleFixture(() => {
      issued += 1;
      return TOKEN;
    });
    fixture.input.write('b\n');
    await settle();
    expect(issued).toBe(1);
    expect(fixture.text()).toContain(`Owner alpha bootstrap: ${ORIGIN}/owner/bootstrap?token=${TOKEN}`);

    fixture.input.write('b\nb\n');
    await settle();
    expect(issued).toBe(3);
    fixture.dispose();
  });

  test('ignores blank lines and reminds on unknown commands without issuing tokens', async () => {
    let issued = 0;
    const fixture = consoleFixture(() => {
      issued += 1;
      return TOKEN;
    });
    fixture.input.write('\n   \nB\nbootstrap\nhelp\n');
    await settle();
    expect(issued).toBe(0);
    expect(fixture.text()).toContain("enter 'b'");
    expect(fixture.text()).not.toContain('token=');
    fixture.dispose();
  });

  test('reports issuance failures without crashing and keeps accepting input', async () => {
    let calls = 0;
    const fixture = consoleFixture(() => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('at capacity');
        error.code = 'owner-session-capacity';
        throw error;
      }
      return TOKEN;
    });
    fixture.input.write('b\n');
    await settle();
    expect(fixture.text()).toContain('owner-session-capacity');
    fixture.input.write('b\n');
    await settle();
    expect(fixture.text()).toContain(`token=${TOKEN}`);
    fixture.dispose();
  });

  test('dispose stops reacting to further input', async () => {
    let issued = 0;
    const fixture = consoleFixture(() => {
      issued += 1;
      return TOKEN;
    });
    fixture.dispose();
    fixture.input.write('b\n');
    await settle();
    expect(issued).toBe(0);
  });

  test('rejects missing dependencies', () => {
    expect(() => startBootstrapConsole({})).toThrow(TypeError);
  });
});
