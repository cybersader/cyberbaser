import assert from "node:assert/strict"
import { turnstile } from "../components/challenge/providers/turnstile"
import { getChallengeProvider } from "../components/challenge/registry"
import { runChallengeProviderConformance } from "./conformance/challenge-provider"

assert.equal(getChallengeProvider("turnstile"), turnstile)
assert.equal(getChallengeProvider("toString"), undefined)
assert.equal(getChallengeProvider("__proto__"), undefined)

runChallengeProviderConformance(turnstile, {
  siteKey: "conformance-public-site-key",
  install(fakeWindow) {
    let mountedContainer: HTMLElement | undefined
    let mountedOptions: Record<string, any> = {}
    let resets = 0
    let removals = 0
    fakeWindow.turnstile = {
      render(container: HTMLElement, options: Record<string, any>) {
        mountedContainer = container
        mountedOptions = options
        return "conformance-widget"
      },
      getResponse() { assert.fail("the SDK callback already supplied the token") },
      reset(id: string) { assert.equal(id, "conformance-widget"); resets++ },
      remove(id: string) { assert.equal(id, "conformance-widget"); removals++ },
    }
    return {
      assertMounted(container, options) {
        assert.equal(mountedContainer, container)
        assert.equal(mountedOptions.sitekey, options.siteKey)
        assert.equal(mountedOptions.action, options.action)
        assert.equal(mountedOptions["response-field"], false, "the SDK must not inject a token form field")
      },
      token: (value) => mountedOptions.callback(value),
      expire: () => mountedOptions["expired-callback"](),
      error: () => mountedOptions["error-callback"](),
      resetCount: () => resets,
      removeCount: () => removals,
    }
  },
})

console.log("turnstile challenge-provider conformance checks passed")
