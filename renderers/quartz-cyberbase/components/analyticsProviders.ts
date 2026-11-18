/**
 * Optional page analytics, behind a provider interface so a site can plug in
 * its own (Plausible, Umami, self-hosted PostHog...) by adding a provider.
 *
 * Off unless the layout enables it. Settings are validated at build time and
 * embedded as JSON, never string-spliced into script source.
 * Copied into `<quartz>/quartz/components/` by setup.sh. Pure, no DOM.
 */
export interface AnalyticsProvider {
  readonly id: string
  /** Inline browser script that loads the provider and records SPA page views. */
  script(): string
}

export interface PostHogOptions {
  /** Public project key (phc_...). Client keys are public by design. */
  apiKey: string
  /** Ingestion host, for example https://us.i.posthog.com. */
  apiHost: string
  personProfiles?: "identified_only" | "always" | "never"
}

export function posthogProvider(opts: PostHogOptions): AnalyticsProvider {
  if (!/^phc_[A-Za-z0-9]{20,80}$/.test(opts.apiKey)) throw new Error("PostHog apiKey must be a phc_ project key")
  const host = new URL(opts.apiHost)
  if (host.protocol !== "https:" || host.pathname !== "/" || host.search || host.hash) throw new Error("PostHog apiHost must be a bare https origin")
  const settings = JSON.stringify({
    key: opts.apiKey,
    init: { api_host: host.origin, person_profiles: opts.personProfiles ?? "identified_only", capture_pageview: false },
  })
  return {
    id: "posthog",
    // Official PostHog loader stub (as vendored by Quartz 4.5.2), then init.
    script: () => `(() => {
  if (window.__cbAnalytics) return; window.__cbAnalytics = true
  const settings = ${settings}
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  window.posthog.init(settings.key, settings.init)
  document.addEventListener("nav", () => window.posthog.capture("$pageview", { path: location.pathname }))
})()`,
  }
}
