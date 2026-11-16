#!/usr/bin/env bun
import path from 'node:path';
import { assertPrerequisites, createSuggestionsFixture, optionsFromArgs, PROJECT_ROOT, QUOTE, REPLACEMENT, startSuggestionsRehearsal } from './suggestions-rehearsal-fixture.js';

export function instructions(fixture) {
  return [
    'Disposable suggestions rehearsal. No real vault or public site is changed.',
    `Owned throwaway state: ${fixture.root}`,
    `Private site: ${fixture.readerOrigin}/cyberbase/`,
    `MFA methods page: ${fixture.readerOrigin}/cyberbase/mfa-methods`,
    `Proposals: ${fixture.ownerOrigin}/owner/review`,
    'Sign in: open the one-time bootstrap URL printed below in your own browser. It signs in this browser only.',
    'The bootstrap link is a temporary local capability. Do not share the terminal output.',
    '',
    'Try this:',
    '1. Open the bootstrap link, then open MFA methods on the private site.',
    `2. Select and copy exactly “${QUOTE}”, open Suggest a correction, and paste into Text to replace. Enter “${REPLACEMENT}” as the replacement, explain why, and send. Expect a receipt.`,
    '3. Before approving, send two more distinct suggestions about that same page. The second attempt gets a receipt; the third is rate-limited. Two attempts per page are allowed. Do this now, before the page rebuild changes its ID.',
    '4. Open Proposals, open the first suggestion, and read the before/after change. Choose Approve. The page has not changed yet.',
    '5. On the approved receipt choose Apply to page. Follow the job to Local rehearsal complete. Rendering, exact application, commit, local push and private-site rebuild are real; deployment and live confirmation are simulated.',
    '6. Reload MFA methods on the private site. It now says SMS codes are not phishing-resistant. The other pages and undeclared source bytes stay unchanged.',
    '',
    ...(fixture.challenge === null ? [] : [
      `Cloudflare published TEST keys: ${fixture.challenge}. This mode needs internet access to challenges.cloudflare.com.`,
      ...(fixture.challenge === 'pass' ? ['The test widget passes; the normal six steps and page limit still apply.'] : [
        'The challenge is deliberately refused. Expect no receipt and no new proposal; approval/application steps cannot follow in this mode.',
        'Failed challenges still count against the sender limit. Restart in ordinary or --challenge pass mode to try the complete loop.',
      ]),
    ]),
    'Ctrl-C or q then Enter stops all owned services.',
    fixture.keep ? `--keep: stopped state will remain at ${fixture.root}` : 'Cleanup removes this run’s throwaway state. Add --keep on a new run to retain it.',
    'Enter b then Enter for another one-time sign-in URL. No browser is launched automatically.',
  ].join('\n');
}

export async function runSuggestionsLauncher(args = process.argv.slice(2)) {
  const options = optionsFromArgs(args);
  if (options.prepare) {
    const child = Bun.spawn(['build-contained', '--', 'bash', path.join(import.meta.dir, 'suggestions-rehearsal-prepare.sh')],
      { cwd: PROJECT_ROOT, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    process.exitCode = await child.exited;
    return;
  }
  await assertPrerequisites();
  const fixture = await createSuggestionsFixture(options);
  process.stdout.write(`Creating a throwaway private site. Owned state: ${fixture.root}\nThe first real Quartz build may take a minute.\n`);
  let runtime; let stopping = false; let disposeInput = () => {};
  const startup = startSuggestionsRehearsal(fixture);
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    disposeInput();
    process.stdout.write('Stopping the owned services; waiting for any active local job to settle.\n');
    try {
      await startup.catch(() => {});
      await fixture.cleanup();
      process.stdout.write(options.keep ? `Stopped. Throwaway state retained: ${fixture.root}\n` : 'Stopped. Owned services closed and throwaway state removed.\n');
      process.exit(code);
    } catch {
      process.stderr.write(`Cleanup did not finish. State retained at ${fixture.root}; do not delete it while an owned job is active.\n`);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  try {
    runtime = await startup;
    if (stopping) return;
    const issueSignIn = () => process.stdout.write(`Owner alpha bootstrap: ${fixture.ownerOrigin}/owner/bootstrap?token=${runtime.issueBootstrap()}\n`);
    process.stdout.write(`${instructions(fixture)}\n`);
    issueSignIn();
    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8'); process.stdin.resume();
      const onData = (chunk) => {
        for (const line of chunk.split(/\r?\n/u)) {
          if (line.trim().toLowerCase() === 'q') void stop();
          else if (line.trim().toLowerCase() === 'b' && !stopping) issueSignIn();
        }
      };
      process.stdin.on('data', onData);
      disposeInput = () => { process.stdin.off('data', onData); process.stdin.pause(); };
    }
    await new Promise(() => {});
  } catch (error) {
    process.stderr.write(`Suggestions rehearsal could not start (${error?.code ?? 'startup-error'}). No real vault was opened.\n`);
    if (error?.code === 'invalid-config' || error?.code?.startsWith('invalid-config-')) process.stderr.write('This checkout may not yet accept suggestions.form.challenge; use the ordinary mode or finish the owner challenge configuration change.\n');
    await stop(1);
  }
}

if (import.meta.main) runSuggestionsLauncher().catch((error) => {
  // Our prerequisite/argument messages contain no capability or raw child error.
  process.stderr.write(`${error instanceof Error ? error.message : 'Suggestions rehearsal failed.'}\n`);
  process.exitCode = 1;
});
