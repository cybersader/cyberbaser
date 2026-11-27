// The systemd unit files, embedded in the program as text.
import node from '../systemd/cyberbaser-node.service' with { type: 'text' };
import publisher from '../systemd/cyberbaser-publisher.service' with { type: 'text' };
import configPath from '../systemd/cyberbaser-config.path' with { type: 'text' };
import configApply from '../systemd/cyberbaser-config-apply.service' with { type: 'text' };
import hardening from '../systemd/hardening.conf' with { type: 'text' };

export const UNIT_TEXTS = Object.freeze({
  'cyberbaser-node.service': node,
  'cyberbaser-publisher.service': publisher,
  'cyberbaser-config.path': configPath,
  'cyberbaser-config-apply.service': configApply,
});
export const HARDENING = hardening;
