// Debug helper (test container only): run the node's site build and print the failure details.
import { loadOwnerAlphaConfig } from '/src/apps/owner-alpha/src/config.js';
import { ensureOwnerSite } from '/src/apps/owner-alpha/src/site.js';

const config = await loadOwnerAlphaConfig('/var/lib/cyberbaser/config/owner-alpha.json');
try {
  await ensureOwnerSite({ config, projectRoot: '/opt/cyberbaser' });
  console.log('site ok');
} catch (error) {
  console.log(error.code, error.message, JSON.stringify(error.details ?? {}, null, 1).slice(0, 3000));
}
