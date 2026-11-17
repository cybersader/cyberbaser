import { posthogProvider } from "../components/analyticsProviders"
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
const key = "phc_599knGAT15HiAYE5nHJjTqIlAY3O6e2F3QdlFzIRHKb"
const script = posthogProvider({ apiKey: key, apiHost: "https://us.i.posthog.com", personProfiles: "identified_only" }).script()
assert(script.includes('"person_profiles":"identified_only"') && script.includes('"api_host":"https://us.i.posthog.com"') && script.includes('"capture_pageview":false'), "posthog settings")

// Simulate a page: loader inserted once, one init, one pageview per SPA navigation.
const loads: unknown[] = []
const listeners: Record<string, () => void> = {}
const fakeDocument = {
  addEventListener: (name: string, fn: () => void) => { listeners[name] = fn },
  createElement: () => ({}),
  getElementsByTagName: () => [{ parentNode: { insertBefore: (node: unknown) => loads.push(node) } }],
}
const fakeWindow: any = {}
const run = new Function("window", "document", "location", script)
run(fakeWindow, fakeDocument, { pathname: "/a" })
run(fakeWindow, fakeDocument, { pathname: "/a" })
listeners.nav(); listeners.nav()
const queued = fakeWindow.posthog._i?.[0]
assert(loads.length === 1, `loader inserted ${loads.length} times`)
assert(queued?.[0] === key && queued[1].person_profiles === "identified_only" && queued[1].api_host === "https://us.i.posthog.com", "init settings")
assert(fakeWindow.posthog.filter((call: unknown[]) => call[0] === "capture").length === 2, "pageview per navigation")

for (const bad of [
  { apiKey: "phc_x');alert(1)//aaaaaaaaaaaaaaaaaaaa", apiHost: "https://us.i.posthog.com" },
  { apiKey: key, apiHost: "http://us.i.posthog.com" },
  { apiKey: key, apiHost: "https://us.i.posthog.com/path" },
]) {
  let threw = false
  try { posthogProvider(bad) } catch { threw = true }
  assert(threw, `accepted ${JSON.stringify(bad)}`)
}
console.log("analytics: posthog settings, single init, SPA pageviews and key/host validation passed")
