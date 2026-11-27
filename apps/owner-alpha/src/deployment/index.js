import {
  discoverGithubActionsRun,
  monitorGithubActionsDeployment,
} from './github-actions.js';
import {
  discoverForgejoActionsRun,
  monitorForgejoActionsDeployment,
} from './forgejo-actions.js';
import { discoverPrivateSiteRun, monitorPrivateSiteDeployment, PRIVATE_SITE_PROVIDER } from './private-site.js';
import { fail } from '../errors.js';

function provider(config) {
  const value = config?.workflow?.provider;
  if (value === 'github-actions' || value === 'forgejo-actions' || value === PRIVATE_SITE_PROVIDER) return value;
  fail('unsupported-deployment-provider', 'unsupported deployment observation provider');
}

export async function discoverDeploymentRun(input = {}, dependencies = {}) {
  switch (provider(input.config)) {
    case 'github-actions':
      return discoverGithubActionsRun(input, dependencies);
    case 'forgejo-actions':
      return discoverForgejoActionsRun(input, dependencies);
    case PRIVATE_SITE_PROVIDER:
      return discoverPrivateSiteRun(input, dependencies);
    default:
      throw new Error('unreachable deployment provider');
  }
}

export async function monitorDeploymentRun(input = {}, dependencies = {}) {
  switch (provider(input.config)) {
    case 'github-actions':
      return monitorGithubActionsDeployment(input, dependencies);
    case 'forgejo-actions':
      return monitorForgejoActionsDeployment(input, dependencies);
    case PRIVATE_SITE_PROVIDER:
      return monitorPrivateSiteDeployment(input, dependencies);
    default:
      throw new Error('unreachable deployment provider');
  }
}
