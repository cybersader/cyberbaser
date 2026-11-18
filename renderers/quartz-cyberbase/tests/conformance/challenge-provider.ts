import assert from "node:assert/strict"
import type { ChallengeMountOptions, ChallengeProvider } from "../../components/challenge/registry"

/** Only this fixture knows the vendor SDK; the assertions below are shared. */
export interface ChallengeProviderFixture {
  siteKey: string
  install(fakeWindow: Record<string, unknown>): {
    assertMounted(container: HTMLElement, options: Pick<ChallengeMountOptions, "siteKey" | "action">): void
    token(value: string): void
    expire(): void
    error(): void
    resetCount(): number
    removeCount(): number
  }
}

/**
 * Run synchronously against a fake DOM/global, with no script or network access.
 * A provider PR adds its SDK fixture and calls this unchanged shared suite.
 */
export function runChallengeProviderConformance(provider: ChallengeProvider, fixture: ChallengeProviderFixture): void {
  assert.match(provider.id, /^[a-z][a-z0-9-]*$/u)
  const scriptUrl = provider.scriptUrl
  assert.equal(typeof scriptUrl, "string")
  const url = new URL(scriptUrl)
  assert.equal(url.protocol, "https:")
  assert.equal(url.username, "")
  assert.equal(url.password, "")
  assert.equal(url.hash, "")
  assert.equal(url.toString(), scriptUrl)
  assert.equal(provider.validateSiteKey(fixture.siteKey), true)
  for (const unsafe of ["", "unsafe key", "key\n", "key\r", "key\u0000", "key\u007f", '\"><script>']) {
    assert.equal(provider.validateSiteKey(unsafe), false, `accepted unsafe site key ${JSON.stringify(unsafe)}`)
  }

  const fakeWindow: Record<string, unknown> = {}
  const fakeDocument = {
    createElement(tag: string) {
      assert.equal(tag, "div", "providers must leave script loading to core")
      return { tagName: "DIV", dataset: {}, children: [] as unknown[], appendChild(child: unknown) { this.children.push(child) } }
    },
    head: { appendChild() { assert.fail("providers must leave script loading to core") } },
  }
  const originals = new Map(["window", "document", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    define("window", fakeWindow)
    define("document", fakeDocument)
    const noNetwork = () => { assert.fail("providers must not send requests") }
    define("fetch", noNetwork)
    fakeWindow.fetch = noNetwork
    const controls = fixture.install(fakeWindow)
    const container = fakeDocument.createElement("div") as unknown as HTMLElement
    const tokens: string[] = []
    let expired = 0
    let errors = 0
    const options: ChallengeMountOptions = {
      siteKey: fixture.siteKey,
      action: "conformance-action",
      onToken: (token) => tokens.push(token),
      onExpire: () => { expired++ },
      onError: () => { errors++ },
    }
    const widget = provider.mount(container, options)
    controls.assertMounted(container, options)
    assert.deepEqual(tokens, [])
    controls.token("first-conformance-token")
    controls.token("second-conformance-token")
    assert.deepEqual(tokens, ["first-conformance-token", "second-conformance-token"])
    controls.expire()
    controls.error()
    assert.equal(expired, 1)
    assert.equal(errors, 1)
    assert.equal(typeof widget.reset, "function")
    assert.equal(typeof widget.remove, "function")
    assert.equal(controls.resetCount(), 0)
    widget.reset()
    assert.equal(controls.resetCount(), 1)
    assert.equal(controls.removeCount(), 0)
    widget.remove()
    assert.equal(controls.removeCount(), 1)
    assert.equal(provider.scriptUrl, scriptUrl, "scriptUrl must remain constant across lifecycle operations")
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}
