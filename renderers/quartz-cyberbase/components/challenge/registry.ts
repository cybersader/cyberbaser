import { turnstile } from "./providers/turnstile"

export interface ChallengeMountOptions {
  siteKey: string
  action: string
  onToken(token: string): void
  onExpire(): void
  onError(): void
}

export interface ChallengeWidget {
  reset(): void
  remove(): void
}

/**
 * Browser challenge adapter. Modules must be safe to import during a build:
 * access browser globals only inside mount(), after core has loaded scriptUrl.
 * scriptUrl is a constant credential-free HTTPS URL, never derived from input.
 * validateSiteKey is pure and rejects unsafe public configuration. mount renders
 * only into its container and reports tokens/expiry/errors through callbacks.
 * Disable vendor-generated response fields: tokens must not enter form data.
 * Providers never load scripts, send requests, store tokens, or manage the form.
 * Core owns script loading, token bounds/header transport, submission gating,
 * per-attempt reset, SPA cleanup, and user-facing messages.
 */
export interface ChallengeProvider {
  readonly id: string
  readonly scriptUrl: string
  validateSiteKey(key: string): boolean
  mount(container: HTMLElement, options: ChallengeMountOptions): ChallengeWidget
}

export const DEFAULT_CHALLENGE_PROVIDER = "turnstile"

// Static imports are bundled with Quartz's inline entry. No dynamic import,
// input-derived URL, provider-specific branch, or runtime plugin fetch is needed.
const providers: ReadonlyMap<string, ChallengeProvider> = new Map([
  [turnstile.id, turnstile],
])

export function getChallengeProvider(id: string): ChallengeProvider | undefined {
  return providers.get(id)
}
