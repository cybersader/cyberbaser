// The platform seam. Each platform supplies install, uninstall and status with
// the same contract: (args, { programPath, compiled }) => exit code.
//   linux  : systemd system services, two system accounts (built)
//   darwin : launchd daemons, two hidden role accounts (designed, not built)
//   win32  : Windows services under two virtual service accounts (designed, not built)
import * as linux from './linux-systemd.js';

function notYet(name, plan) {
  const message = () => {
    process.stderr.write(`Installing on ${name} is not built yet. Planned: ${plan}\n`);
    return 1;
  };
  return Object.freeze({ install: message, uninstall: message, status: message });
}

export function platformFor(platform) {
  if (platform === 'linux') return linux;
  if (platform === 'darwin') return notYet('macOS', 'launchd daemons with two hidden role accounts; see the deployment design page.');
  if (platform === 'win32') return notYet('Windows', 'two Windows services under virtual service accounts and a named pipe; see the deployment design page.');
  return notYet(platform, 'none.');
}
