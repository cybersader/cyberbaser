import { createInterface } from 'node:readline';

export function formatBootstrapUrl(ownerOrigin, token) {
  return `${ownerOrigin}/owner/bootstrap?token=${token}`;
}

// Local console access is the owner authority boundary for minting sign-in
// capabilities; no HTTP route may re-arm the bootstrap.
export function startBootstrapConsole({ input, output, ownerOrigin, issueBootstrap }) {
  if (!input || !output || typeof issueBootstrap !== 'function' || typeof ownerOrigin !== 'string') {
    throw new TypeError('input, output, ownerOrigin, and issueBootstrap are required');
  }

  const reader = createInterface({ input, terminal: false });
  reader.on('line', (line) => {
    const command = line.trim();
    if (command === '') return;
    if (command !== 'b') {
      output.write("Owner alpha console: enter 'b' for a one-time sign-in link for another device\n");
      return;
    }
    try {
      const token = issueBootstrap();
      output.write(`Owner alpha bootstrap: ${formatBootstrapUrl(ownerOrigin, token)}\n`);
      output.write('Open this one-time link on the device you want to sign in; it replaces any unused link.\n');
    } catch (error) {
      output.write(`Owner alpha console: could not issue a sign-in link (${error?.code ?? 'unexpected-error'})\n`);
    }
  });

  return function disposeBootstrapConsole() {
    reader.close();
  };
}
