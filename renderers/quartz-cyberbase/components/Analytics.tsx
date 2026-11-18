import { QuartzComponentConstructor } from "./types"
import type { AnalyticsProvider } from "./analyticsProviders"

/** Renders nothing; contributes the provider's page-view script. */
export default ((provider: AnalyticsProvider) => {
  function Analytics() {
    return null
  }
  Analytics.afterDOMLoaded = provider.script()
  return Analytics
}) satisfies QuartzComponentConstructor<AnalyticsProvider>
