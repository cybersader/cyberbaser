#!/usr/bin/env bun
import path from 'node:path';
import { assertPrerequisites, createSuggestionsFixture, optionsFromArgs, PROJECT_ROOT, startSuggestionsRehearsal } from './suggestions-rehearsal-fixture.js';

// Like console 'b', this requires local process authority, not an HTTP request.
// The capability is still printed only to this launcher's existing output.
export function installSignInSignal({ target = process, issueSignIn }) {
  target.on('SIGUSR1', issueSignIn);
  return () => target.off('SIGUSR1', issueSignIn);
}

export function instructions(fixture) {
  return [
    'Disposable suggestions rehearsal. No real vault or public site is changed.',
    `Site home (start here): ${fixture.readerOrigin}/cyberbase/`,
    `Owned throwaway state: ${fixture.root}`,
    ...(fixture.copied ? [
      `Read-only source snapshot: ${fixture.copied.ref} (${fixture.copied.commit})`,
      `Copied ${fixture.copied.pages} Markdown pages (${fixture.copied.publishedPages.length} published) and ${fixture.copied.attachments} referenced attachments.`,
      'Published pages (or follow the links from the site home):',
      ...fixture.copied.pageLinks.slice(0, 5).map((link) => `  ${fixture.readerOrigin}/cyberbase/${link}`),
      'All edits go only to the throwaway copy, never the real vault.',
    ] : [`MFA methods page: ${fixture.readerOrigin}/cyberbase/mfa-methods`]),
    `Proposals: ${fixture.ownerOrigin}/owner/review`,
    'Sign in: open the one-time bootstrap URL printed below in your own browser. It signs in this browser only.',
    'The bootstrap link is a temporary local capability. Do not share the terminal output.',
    '',
    'Try this:',
    fixture.copied ? '1. Open the bootstrap link to sign in, then start from the site home and choose a published page.' : '1. Open the bootstrap link to sign in, then start from the site home and choose MFA methods.',
    '2. Tap Suggest edits, tap into text and type, then choose Review & send.',
    '3. Before approving, send two more distinct suggestions about that same page. The second attempt gets a receipt; the third is rate-limited. Two attempts per page are allowed. Do this now, before the page rebuild changes its ID.',
    '4. Open Proposals, open the first suggestion, and read the before/after change. Choose Approve. The page has not changed yet.',
    '5. On the approved receipt choose Apply to page. Follow the job to Local rehearsal complete. Rendering, exact application, commit, local push and private-site rebuild are real; deployment and live confirmation are simulated.',
    fixture.copied ? '6. Reload the copied page on the private site. Only your declared correction should change. The real source vault stays untouched.' : '6. Reload MFA methods on the private site. It now says SMS codes are not phishing-resistant. The other pages and undeclared source bytes stay unchanged.',
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
    `Fresh sign-in without terminal input: kill -USR1 ${process.pid} (prints a new link here; never shares it over HTTP).`,
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
  let runtime; let stopping = false; let disposeInput = () => {}; let disposeSignInSignal = () => {};
  const startup = startSuggestionsRehearsal(fixture);
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    disposeInput();
    disposeSignInSignal();
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
    const issueSignIn = () => {
      if (!stopping) process.stdout.write(`Owner alpha bootstrap: ${fixture.ownerOrigin}/owner/bootstrap?token=${runtime.issueBootstrap()}\n`);
    };
    disposeSignInSignal = installSignInSignal({ issueSignIn });
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
    process.stderr.write(`Suggestions rehearsal could not start (${error?.code ?? 'startup-error'}). No source vault was changed.\n`);
    if (error?.code === 'invalid-config' || error?.code?.startsWith('invalid-config-')) process.stderr.write('This checkout may not yet accept suggestions.form.challenge; use the ordinary mode or finish the owner challenge configuration change.\n');
    await stop(1);
  }
}

if (import.meta.main) runSuggestionsLauncher().catch((error) => {
  // Our prerequisite/argument messages contain no capability or raw child error.
  process.stderr.write(`${error instanceof Error ? error.message : 'Suggestions rehearsal failed.'}\n`);
  process.exitCode = 1;
});
