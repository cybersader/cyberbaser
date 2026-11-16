import type { ChallengeProvider } from "../registry"

interface Turnstile {
  render(container: HTMLElement, options: {
    sitekey: string
    action: string
    "response-field": false
    callback: (token?: string) => void
    "expired-callback": () => void
    "error-callback": () => void
  }): string
  getResponse(widgetId: string): string
  reset(widgetId: string): void
  remove(widgetId: string): void
}

/** Cloudflare is one adapter, not the form's challenge contract. */
export const turnstile: ChallengeProvider = Object.freeze<ChallengeProvider>({
  id: "turnstile",
  scriptUrl: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  validateSiteKey: (key: string) => /^[A-Za-z0-9_-]{1,256}$/u.test(key),
  mount(container, options) {
    const api = (window as Window & { turnstile?: Turnstile }).turnstile
    if (!api) throw new Error("Turnstile API is unavailable")
    const widgetId = api.render(container, {
      sitekey: options.siteKey,
      action: options.action,
      // Core sends the single-use token only in Cyberbaser-Challenge-Token.
      "response-field": false,
      callback: (token) => {
        try {
          options.onToken(token ?? api.getResponse(widgetId))
        } catch {
          options.onError()
        }
      },
      "expired-callback": options.onExpire,
      "error-callback": options.onError,
    })
    return {
      reset: () => api.reset(widgetId),
      remove: () => api.remove(widgetId),
    }
  },
})
