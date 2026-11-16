#!/usr/bin/env node
// Run with build-contained. Offline pinned Quartz, three synthetic pages, no real vault.
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const renderer = path.join(repo, "renderers/quartz-cyberbase")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cyberbaser-suggesting-"))
const quartz = path.join(temp, "quartz"), input = path.join(temp, "input"), output = path.join(temp, "output")
const original = "---\ntitle: Suggesting fixture\ndate: 2020-01-01\n---\n\nHello **brown** [friendly](https://example.org).\n\nA separate paragraph with 😀 text.\n\n[[target]]\n\n## Alternatives\n\n- [Mobile option](https://example.org/mobile): $2.99/Monthly | $24.99\n- [Desktop option](https://example.org/desktop): a physical macro pad.\n\n$x + y$\n\n<style>.fixture-only { color: inherit; }</style>\n" + "\n> [!tip] Custom title\n> Callout body.\n\n$$\nx + y\n$$\n\nRefused %% private fixture comment %% text.\n\n| Header | Value |\n| --- | --- |\n| Cell | One |\n"
const originalBytes = original.replace(/\n/gu, "\r\n")
let body, browser
const server = http.createServer(async (req, res) => {
  if (req.url === "/v2/suggestions") {
    let raw = ""; for await (const chunk of req) raw += chunk
    body = JSON.parse(raw)
    res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ receipt: { queueId: "Q-built-page" } })); return
  }
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname)
  let file = path.resolve(output, `.${pathname}`)
  if (!file.startsWith(`${output}/`) && file !== output) { res.writeHead(404); res.end(); return }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html")
  if (!fs.existsSync(file) && !path.extname(file)) file += ".html"
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return }
  const types = { ".json": "application/json", ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }); fs.createReadStream(file).pipe(res)
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const env = {
  ...process.env, QUARTZ_OFFLINE: "1", QUARTZ_SEED_DIR: process.env.QUARTZ_SEED_DIR ?? path.join(repo, ".workspace/suggestions-rehearsal-renderer"),
  CYBERBASER_SOURCE_PROVENANCE: "enabled", CYBERBASER_EDIT_LINK_MODE: "public", CYBERBASER_ACCOUNT_FREE_INTAKE: "enabled",
  CYBERBASER_ACCOUNT_FREE_INTAKE_ORIGIN: origin, CYBERBASER_ACCOUNT_FREE_BINDING_DIGEST: `sha-256=:${"A".repeat(43)}=:`,
  CYBERBASER_ACCOUNT_FREE_SOURCE_REPOSITORY: "https://forge.example/owner/wiki.git", CYBERBASER_ACCOUNT_FREE_SOURCE_REVISION: "1".repeat(40), TZ: "UTC",
}
delete env.CYBERBASER_SUGGESTION_CHALLENGE_SITE_KEY
delete env.CYBERBASER_SUGGESTION_CHALLENGE_PROVIDER
function run(command, args, cwd = repo) {
  try { return execFileSync(command, args, { cwd, env, stdio: "pipe", maxBuffer: 32 * 1024 * 1024 }) }
  catch (error) { console.error(error.stdout?.toString(), error.stderr?.toString()); throw error }
}
try {
  fs.mkdirSync(input)
  fs.writeFileSync(path.join(input, "index.md"), originalBytes)
  fs.writeFileSync(path.join(input, "target.md"), "---\ntitle: Target\ndate: 2020-01-01\n---\n\nTarget page text.\n")
  fs.writeFileSync(path.join(input, "third.md"), "---\ntitle: Third\ndate: 2020-01-01\n---\n\nThird page text.\n")
  run("bash", [path.join(renderer, "setup.sh"), quartz])
  run("node", [path.join(quartz, "quartz/bootstrap-cli.mjs"), "build", "-d", input, "-o", output, "--concurrency", "1"], quartz)
  assert.ok(fs.existsSync(path.join(output, "index.provenance.json")))
  const provenance = JSON.parse(fs.readFileSync(path.join(output, "index.provenance.json"), "utf8"))
  assert.equal(provenance.version, 2)
  assert.ok(provenance.blocks.length > 0, "real v2 source blocks must be emitted")
  for (const block of provenance.blocks.filter(block => block.editable)) assert.equal(Buffer.from(originalBytes).subarray(...block.source).toString(), block.text)
  const sourceBlock = needle => {
    const block = provenance.blocks.find(block => block.editable && block.text.includes(needle))
    assert.ok(block, `Missing editable source block ${needle}`)
    return { block, button: page.locator(`[data-cb-node="${block.parent}"] > .cb-source-open`) }
  }
  const { chromium } = await import(pathToFileURL(path.join(repo, "docs/node_modules/@playwright/test/index.mjs")).href)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } })
  const page = await context.newPage()
  const errors = [], blocked = [], editorRequests = []
  page.on("request", request => { if (/\/static\/source-editor\./u.test(request.url())) editorRequests.push(request.url()) })
  page.on("pageerror", error => errors.push(error.message))
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    blocked.push(route.request().url()); return route.abort()
  })
  await page.goto(origin)
  await page.waitForSelector(".cb-suggest-toggle")
  assert.equal(await page.locator("article style > span, article math span").count(), 0)
  assert.equal(await page.locator("article style").evaluate(el => el.childNodes[0].nodeType), 3)
  await page.locator(".suggest-correction-entry").first().click()
  async function select(needle, a, b, tag = "[data-cb-view]") {
    await page.evaluate(({ needle, a, b, tag }) => {
      const parts = [...document.querySelectorAll(`article [data-cb-run] ${tag}`)]
      const part = parts.find(el => el.textContent.includes(needle))
      if (!part) throw Error(`Missing text ${needle}`)
      const at = part.textContent.indexOf(needle)
      part.scrollIntoView({ block: "center" }); document.querySelector("article").focus()
      const range = document.createRange(); range.setStart(part.firstChild, at + a); range.setEnd(part.firstChild, at + b)
      getSelection().removeAllRanges(); getSelection().addRange(range)
    }, { needle, a, b, tag })
  }
  await select("Hello", 5, 5); await page.keyboard.type(", reader")
  await select("brown", 0, 5); await page.keyboard.type("red")
  await select("friendly", 0, 6); await page.keyboard.press("Backspace")
  assert.equal(await page.locator(".cb-suggest-card").count(), 3)
  assert.equal(await page.locator("article strong ins").textContent(), "red")
  assert.equal(await page.locator("article a del").textContent(), "friend")
  // Reproduce the real-page refusal: screenshot caret cleanup adds style=""
  // to contenteditable=false deletion marks. This must not stale the source.
  await page.screenshot()
  assert.ok(await page.locator('article del[style=""]').count() > 0)
  // Editing inside inserted text updates the same source operation.
  await select("red", 1, 2, "ins"); await page.keyboard.type("o")
  assert.equal(await page.locator(".cb-suggest-card").count(), 3)
  await select("rod", 1, 2, "ins"); await page.keyboard.type("e")
  // Newlines, cut and IME follow the same proposal route, never native DOM writes.
  await select("separate", 0, 0); await page.keyboard.press("Enter")
  assert.equal(await page.locator(".cb-suggest-card").count(), 4)
  await page.locator(".cb-suggest-card").last().getByText("Discard", { exact: true }).click()
  await select("separate", 0, 8)
  await page.evaluate(() => document.querySelector("article").dispatchEvent(new ClipboardEvent("cut", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })))
  assert.equal(await page.locator(".cb-suggest-card").count(), 4)
  await page.locator(".cb-suggest-card").last().getByText("Discard", { exact: true }).click()
  await select("separate", 0, 0)
  await page.evaluate(() => {
    const root = document.querySelector("article")
    root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    root.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertCompositionText", data: "中" }))
    root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }))
  })
  assert.equal(await page.locator(".cb-suggest-card").count(), 4)
  await page.locator(".cb-suggest-card").last().getByText("Discard", { exact: true }).click()
  const storage = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("cyberbaser:suggesting:v2:")).map(key => [key, sessionStorage.getItem(key)]))
  assert.equal(storage.length, 1)
  const saved = JSON.parse(storage[0][1])
  assert.equal(saved.operations.length, 3)
  const candidate = [...saved.operations].reverse().reduce((bytes, op) => {
    assert.equal(bytes.subarray(op.start, op.end).toString(), op.expected)
    assert.deepEqual(Object.keys(op), ["operationId", "start", "end", "expected", "replacement"])
    return Buffer.concat([bytes.subarray(0, op.start), Buffer.from(op.replacement), bytes.subarray(op.end)])
  }, Buffer.from(originalBytes)).toString()
  assert.equal(candidate, originalBytes.replace("Hello", "Hello, reader").replace("**brown**", "**red**").replace("[friendly]", "[ly]"))
  await page.reload(); await page.waitForSelector(".cb-suggest-card")
  assert.equal(await page.locator(".cb-suggest-card").count(), 3)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.querySelector(".cb-suggest-tray").classList.contains("cb-suggest-bottom-tray"))
  await page.setViewportSize({ width: 1680, height: 1050 })
  // Real Quartz SPA cleanup restores old nodes and installs exactly one editor.
  await page.locator(".cb-suggest-toggle").click()
  await page.locator("article a").filter({ hasText: "target" }).first().click()
  await page.waitForURL(`${origin}/target`)
  await page.waitForSelector(".cb-suggest-toggle")
  assert.equal(await page.locator(".cb-suggest-tray").count(), 1)
  await page.goBack(); await page.waitForSelector(".cb-suggest-card")
  assert.equal(await page.locator(".cb-suggest-card").count(), 3)
  assert.equal(await page.locator(".cb-suggest-toggle").count(), 1)
  // The untouched page and rendered-only suggestion flow never fetch CM6.
  assert.equal(editorRequests.length, 0)
  await sourceBlock("Hello").button.click()
  assert.equal(await page.locator(".cb-source-editor").count(), 0)
  assert.match(await page.locator(".cb-suggest-status").textContent(), /Discard the rendered-text edits/)
  assert.equal(editorRequests.length, 0)
  // A target-derived wikilink opens the exact source, not an invented rendered mapping.
  const unmapped = page.locator("article .cb-suggest-unmapped").filter({ hasText: "target" }).first()
  await unmapped.click()
  const editor = page.getByRole("textbox", { name: "Markdown source for this block" })
  await editor.waitFor()
  assert.equal(editorRequests.length, 1)
  assert.equal(await page.locator(".cb-source-editor > strong").textContent(), "Editing Markdown source")
  async function editSource(text, old, replacement) {
    await editor.press("Control+Home")
    const at = text.indexOf(old); assert.ok(at >= 0)
    for (const _ of [...text.slice(0, at)]) await editor.press("ArrowRight")
    for (const _ of [...old]) await editor.press("Shift+ArrowRight")
    await page.keyboard.type(replacement)
  }
  await editSource("[[target]]", "target", "third")
  assert.equal(await page.locator(".cb-source-insert").textContent(), "third")
  assert.equal(await page.locator(".cb-source-delete").textContent(), "target")
  // Cancel and Escape discard the draft and return focus without touching pending changes.
  await page.locator(".cb-source-cancel").click()
  assert.equal(await page.locator(".cb-suggest-card").count(), 3)
  assert.equal(await unmapped.evaluate(el => el === document.activeElement), true)
  await unmapped.press("Enter"); await editor.waitFor()
  await editor.press("Escape")
  assert.equal(await page.locator(".cb-source-editor").count(), 0)
  await unmapped.click(); await editor.waitFor()
  await editSource("[[target]]", "target", "third")
  await page.locator(".cb-source-done").click()
  assert.equal(await page.locator(".cb-suggest-card").count(), 4)
  assert.equal(await page.locator(".cb-source-badge").count(), 1)
  // Callouts and display math use the actual v2 block boundaries, including CRLF.
  for (const [needle, old, replacement] of [["Custom title", "Custom title", "New title"], ["$$", "x", "z"], ["A separate", "😀", "🌍"], ["| Header", "Header", "Heading"]]) {
    const { block, button } = sourceBlock(needle)
    await button.click(); await editor.waitFor()
    if (needle === "$$") {
      await editor.press("Control+Home"); await editor.press("ArrowDown"); await editor.press("Home"); await editor.press("Shift+ArrowRight"); await page.keyboard.type(replacement)
    } else await editSource(block.text, old, replacement)
    await page.locator(".cb-source-done").click()
  }
  assert.equal(editorRequests.length, 1, "the same-origin bundle loads once across all sessions")
  assert.equal(await page.locator(".cb-source-badge").count(), 5)
  assert.equal(await page.locator(".cb-suggest-card").count(), 8)
  // A pending source edit locks rendered editing in that block, even outside its splice.
  await select("separate", 0, 8); await page.keyboard.type("bad")
  assert.match(await page.locator(".cb-suggest-status").textContent(), /Use Edit source/)
  assert.equal(await page.locator(".cb-suggest-card").count(), 8)
  const rejected = provenance.blocks.find(block => !block.editable && block.reason === "obsidian-comment")
  assert.ok(rejected)
  await page.locator(`[data-cb-node="${rejected.parent}"] > .cb-source-open`).click()
  assert.equal(await page.locator(".cb-source-editor").count(), 0)
  assert.match(await page.locator(".cb-suggest-status").textContent(), /obsidian-comment/)
  const sourceSaved = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith("cyberbaser:suggesting:v2:") && !key.endsWith(":retry")))))
  const sourceCandidate = [...sourceSaved.operations].reverse().reduce((bytes, op) => {
    assert.equal(bytes.subarray(op.start, op.end).toString(), op.expected)
    assert.deepEqual(Object.keys(op), ["operationId", "start", "end", "expected", "replacement"])
    return Buffer.concat([bytes.subarray(0, op.start), Buffer.from(op.replacement), bytes.subarray(op.end)])
  }, Buffer.from(originalBytes)).toString()
  assert.equal(sourceCandidate, originalBytes.replace("Hello", "Hello, reader").replace("**brown**", "**red**").replace("[friendly]", "[ly]").replace("[[target]]", "[[third]]").replace("Custom title", "New title").replace("$$\r\nx", () => "$$\r\nz").replace("😀 text", "🌍 text").replace("| Header", "| Heading"))
  await page.reload(); await page.waitForSelector(".cb-source-badge")
  assert.equal(await page.locator(".cb-suggest-card").count(), 8)
  assert.equal(await page.locator(".cb-source-badge").count(), 5)
  await sourceBlock("[[target]]").button.click(); await editor.waitFor()
  assert.ok((await editor.textContent()).includes("third"))
  await editor.press("Escape")
  await page.locator(".cb-suggest-review").click()
  await page.locator(".cb-suggest-card textarea").first().fill("Please use this wording.")
  await page.locator(".suggest-correction-form:visible input[name=rationale]").fill("Batch rationale.")
  await page.screenshot()
  await page.locator(".suggest-correction-form:visible button[type=submit]").click()
  await page.waitForFunction(() => document.querySelector(".cb-suggest-status")?.textContent.includes("Q-built-page"))
  assert.equal(body.schemaVersion, 2); assert.equal(body.artifactType, "cyberbaser-account-free-correction-intent")
  assert.equal(body.operations.length, 8); assert.match(body.rationale, /Please use this wording/)
  assert.equal(await page.locator("article ins, article del").count(), 0)
  assert.equal(await page.locator("article strong").textContent(), "brown")
  assert.equal(await page.locator(".cb-suggest-card").count(), 0)
  assert.equal(await page.locator("input[name=rationale]").first().inputValue(), "")
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("cyberbaser:suggesting:v2:")).length), 0)
  // Mutated text after mapping refuses a suggestion without inventing offsets.
  await page.locator(".suggest-correction-entry").first().click()
  await page.evaluate(() => { document.querySelector("article [data-cb-view]").firstChild.textContent = "stale DOM" })
  await select("stale DOM", 0, 5); await page.keyboard.type("bad")
  assert.equal(await page.locator(".cb-suggest-card").count(), 0)
  assert.match(await page.locator(".cb-suggest-status").textContent(), /cannot be safely edited/)
  // Older v1 sidecars retain the original refusal instead of guessing block source.
  await context.route("**/index.provenance.json", async route => {
    const value = { ...provenance, version: 1 }; delete value.blocks
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) })
  })
  await page.reload(); await page.waitForSelector(".cb-suggest-toggle")
  await page.locator(".suggest-correction-entry").first().click()
  await page.locator("article .cb-suggest-unmapped").filter({ hasText: "target" }).first().click()
  assert.equal(await page.locator(".cb-source-open").count(), 0)
  assert.equal(await page.locator(".cb-source-editor").count(), 0)
  assert.match(await page.locator(".cb-suggest-status").textContent(), /cannot be safely edited/)
  await context.unroute("**/index.provenance.json")
  // Stale sidecar and missing sidecar both keep the legacy editor working.
  await context.route("**/index.provenance.json", async route => {
    const value = JSON.parse(fs.readFileSync(path.join(output, "index.provenance.json"), "utf8")); value.source.sha256 = "f".repeat(64)
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) })
  })
  await page.reload(); await page.waitForSelector(".suggest-edit-pencil", { state: "attached" })
  assert.equal(await page.locator(".cb-suggest-toggle").count(), 0)
  await page.locator(".suggest-edit-pencil").first().click()
  assert.equal(await page.locator("textarea[name=edited]").isVisible(), true)
  await context.unroute("**/index.provenance.json")
  await context.route("**/index.provenance.json", route => route.fulfill({ status: 404, body: "" }))
  await page.reload(); await page.waitForSelector(".suggest-edit-pencil", { state: "attached" })
  assert.equal(await page.locator(".cb-suggest-toggle").count(), 0)
  assert.deepEqual(errors, [])
  // Quartz's optional fonts may be attempted by its pre-existing theme; all are blocked offline.
  console.log("suggest-build: 3-page offline Quartz build, 8 exact-source edits (rendered bold/link/insert plus CM6 wikilink/callout/math/emoji/table), inserted-text/newline/cut/IME editing, persistence, mobile tray, MathML/raw-text preservation, SPA cleanup, screenshot-caret regression, refusal, v2 receipt, unchanged page, stale/missing fallback v2 real blocks, CRLF preservation, lazy one-request CM6, source decorations/cancel/Escape/focus/persistence, overlap/refusal, v1 no-block fallback and zero page errors passed")
  if (blocked.length) console.log(`suggest-build: blocked ${blocked.length} pre-existing external theme resource requests; no external request was sent`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(temp, { recursive: true, force: true })
}
