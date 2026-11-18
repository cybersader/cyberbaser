import { createHash } from "crypto"
import { fallbackScript, headingFragment, normalizeLegacyPath, parseSnapshot, stubHtml } from "../plugins/legacyUrlsCore"
import { resolveSiteBaseUrl, siteBasePath } from "../plugins/siteBase"
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }

// One key for every spelling the old host accepted.
const canonical = normalizeLegacyPath("📁+03+-+Curations,+Stacks/Awesome+AI/Awesome+AI")
for (const variant of [
  "/📁+03+-+curations,+stacks/awesome+ai/awesome+ai/",
  "%F0%9F%93%81%2003%20-%20Curations%2C%20Stacks/Awesome%20AI/Awesome%20AI",
  "📁 03 - Curations, Stacks/Awesome AI/Awesome AI.md",
  "/📁+03+-+Curations,+Stacks/Awesome+AI/Awesome+AI.html",
]) assert(normalizeLegacyPath(variant) === canonical, `variant ${variant} -> ${normalizeLegacyPath(variant)}`)
assert(normalizeLegacyPath("%E0%A4%A") === "%e0%a4%a", "undecodable input kept")
assert(normalizeLegacyPath("Café") === normalizeLegacyPath("Café"), "NFC")

// Heading fragments become Quartz heading ids.
assert(headingFragment("Random+AI") === "random-ai", headingFragment("Random+AI"))
assert(headingFragment("Where%20are%20we%20then%3F") === "where-are-we-then", headingFragment("Where%20are%20we%20then%3F"))
assert(headingFragment("^block-1") === "^block-1", "block refs kept")
assert(headingFragment("Tools…mostly ai rn") === "toolsmostly-ai-rn", headingFragment("Tools…mostly ai rn"))

// Snapshot validation.
parseSnapshot(JSON.stringify({ urls: [{ old: "a+b", source: "a b.md" }, { old: "x", source: "x.md", permalink: "y" }] }))
for (const bad of [{}, { urls: [{ old: "", source: "a.md" }] }, { urls: [{ old: "a", source: "a.txt" }] }, { urls: [{ old: "../etc", source: "a.md" }] }]) {
  let threw = false; try { parseSnapshot(JSON.stringify(bad)) } catch { threw = true }
  assert(threw, `accepted ${JSON.stringify(bad)}`)
}

// Base URL.
assert(resolveSiteBaseUrl({}) === "cybersader.github.io/cyberbase", "default")
assert(resolveSiteBaseUrl({ CB_BASE_URL: "cybersader.com" }) === "cybersader.com", "CB_BASE_URL")
assert(resolveSiteBaseUrl({ CYBERBASER_BASE_URL: "cybersader.com/", CB_BASE_URL: "x.org" }) === "cybersader.com", "precedence and trailing slash")
for (const bad of ["https://cybersader.com", "cybersader.com/a b", "localhost", "cybersader.com/../x"]) {
  let threw = false; try { resolveSiteBaseUrl({ CYBERBASER_BASE_URL: bad }) } catch { threw = true }
  assert(threw, `accepted base ${bad}`)
}
assert(siteBasePath("cybersader.com") === "" && siteBasePath("cybersader.github.io/cyberbase") === "/cyberbase", "base path")

// Redirect page: escaped target, fragment carried.
const stub = stubHtml("../📁-03/A&B")
assert(stub.includes('content="0; url=../📁-03/A&amp;B"') && stub.includes('rel="canonical"'), "stub attributes")
const scriptBody = /<script>([\s\S]*)<\/script>/.exec(stub)![1]
let replaced = ""
new Function("location", scriptBody)({ hash: "#Random+AI", replace: (u: string) => { replaced = u } })
assert(replaced === "../📁-03/A&B#random-ai", replaced)

// 404 fallback: hashed lookup, forward with fragment, retired notice, README home, real 404 untouched.
const hash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32)
const map: Record<string, string | 0> = { [hash(canonical)]: "📁-03---Curations,-Stacks/Awesome-AI/Awesome-AI", [hash("daily/2024")]: 0, [hash("readme")]: "" }
assert(!JSON.stringify(map).includes("daily"), "retired paths are not listed in clear text")
async function runFallback(pathname: string, hashPart = "", slug = "404") {
  let target = ""; const prepended: string[] = []
  const article = { prepend: (node: { textContent: string }) => prepended.push(node.textContent) }
  const doc = { body: { dataset: { slug } }, querySelector: () => article, createElement: () => ({ className: "", textContent: "" }) }
  const loc = { pathname, hash: hashPart, replace: (u: string) => { target = u } }
  const fetchMap = async () => ({ ok: true, json: async () => map })
  new Function("document", "location", "fetch", "crypto", "TextEncoder", fallbackScript("/base", "/base/static/legacy-urls.json"))(doc, loc, fetchMap, globalThis.crypto, TextEncoder)
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { target, prepended }
}
let result = await runFallback("/base/📁+03+-+curations,+stacks/awesome+ai/awesome+ai/", "#Random+AI")
assert(result.target === "/base/📁-03---Curations,-Stacks/Awesome-AI/Awesome-AI#random-ai", `forward ${result.target}`)
result = await runFallback("/base/Daily/2024")
assert(result.target === "" && result.prepended[0]?.includes("no longer public"), "retired notice")
result = await runFallback("/base/README")
assert(result.target === "/base/", `readme ${result.target}`)
result = await runFallback("/base/never-existed")
assert(result.target === "" && result.prepended.length === 0, "unknown path untouched")
result = await runFallback("/base/README", "", "some-page")
assert(result.target === "", "only runs on the 404 page")
console.log("legacy-urls: normalization, heading ids, snapshot validation, base URL, redirect page and hashed 404 fallback passed")
