// Diagnostic program (tests only): the node's private site build, compiled the
// same way as the real program, printing the failure details the node keeps
// private. Build: bun packaging/build.js --entry packaging/test/site-probe.js --outfile <file>
import '../src/runtime.js';
import { loadOwnerAlphaConfig } from '../../apps/owner-alpha/src/config.js';
import { ensureOwnerSite } from '../../apps/owner-alpha/src/site.js';

const config = await loadOwnerAlphaConfig(process.argv[2]);
try {
  await ensureOwnerSite({ config, projectRoot: '/opt/cyberbaser' });
  console.log('site ok');
} catch (error) {
  console.log(error.code, error.message, JSON.stringify(error.details ?? {}, null, 1).slice(0, 4000));
}
