import assert from "node:assert/strict"
import {
  editLinkForPage,
  encodeRepoPath,
  isPrivateNetworkIpv4Host,
  resolveEditLinkMode,
  resolveOwnerOrigin,
} from "../components/editLink"

const publicOptions = {
  mode: "public" as const,
  repoUrl: "https://github.com/cybersader/cyberbase",
  branch: "main",
}

const relativePath = "Research & Notes/🛡️ comma, 100%.md"
const slug = "Research-and-Notes/shield-comma-100-percent"
const encodedRepoPath = "Research%20%26%20Notes/%F0%9F%9B%A1%EF%B8%8F%20comma%2C%20100%25.md"

assert.equal(encodeRepoPath(relativePath), encodedRepoPath)
assert.deepEqual(editLinkForPage(relativePath, slug, publicOptions), {
  href: `https://github.com/cybersader/cyberbase/edit/main/${encodedRepoPath}`,
  external: true,
})
assert.deepEqual(
  editLinkForPage(relativePath, slug, {
    mode: "public",
    repoUrl: "https://github.com/example/vault",
  }),
  {
    href: `https://github.com/example/vault/edit/main/${encodedRepoPath}`,
    external: true,
  },
)

const ownerOptions = { mode: "owner" as const, ownerOrigin: "http://127.0.0.1:4317" }
const ownerLink = editLinkForPage(relativePath, slug, ownerOptions)
assert.deepEqual(ownerLink, {
  href: "http://127.0.0.1:4317/owner/edit?relativePath=Research%20%26%20Notes%2F%F0%9F%9B%A1%EF%B8%8F%20comma%2C%20100%25.md&slug=Research-and-Notes%2Fshield-comma-100-percent",
  external: false,
})
assert.ok(ownerLink)
assert.ok(ownerLink.href.startsWith("http://127.0.0.1:4317/owner/edit?"))
assert.ok(!ownerLink.href.includes("localhost"))
const ownerParams = new URL(ownerLink.href).searchParams
assert.equal(ownerParams.get("relativePath"), relativePath)
assert.equal(ownerParams.get("slug"), slug)

for (const options of [publicOptions, ownerOptions]) {
  assert.equal(editLinkForPage(undefined, "folder", options), null)
  assert.equal(editLinkForPage("tags.md", "tags", options), null)
  assert.equal(editLinkForPage("topic.md", "tags/topic", options), null)
}
assert.equal(editLinkForPage("source.md", undefined, ownerOptions), null)
assert.deepEqual(editLinkForPage("source.md", undefined, publicOptions), {
  href: "https://github.com/cybersader/cyberbase/edit/main/source.md",
  external: true,
})

assert.equal(resolveEditLinkMode(undefined, undefined), "public")
assert.equal(resolveEditLinkMode("", undefined), "public")
assert.equal(resolveEditLinkMode("public", "true"), "public")
assert.equal(resolveEditLinkMode("owner", undefined), "owner")
// Accepted private families: loopback, RFC 1918, RFC 6598 shared space.
for (const origin of [
  "http://127.0.0.1:4317",
  "http://10.1.2.3:4317",
  "http://172.16.5.9:8443",
  "http://192.168.1.50:4317",
  "http://100.100.100.100:4317",
]) {
  assert.equal(resolveOwnerOrigin(origin), origin)
}
const tailnetLink = editLinkForPage(relativePath, slug, {
  mode: "owner",
  ownerOrigin: "http://100.100.100.100:4317",
})
assert.ok(tailnetLink?.href.startsWith("http://100.100.100.100:4317/owner/edit?"))
for (const origin of [
  undefined,
  "",
  "http://localhost:4317",
  "https://127.0.0.1:4317",
  "http://127.0.0.1",
  "http://127.0.0.1:4317/path",
  "http://8.8.8.8:4317",
  "http://169.254.1.1:4317",
  "http://100.64.0.0:4317",
  "http://0.0.0.0:4317",
  "http://[::1]:4317",
  "http://user@127.0.0.1:4317",
]) {
  assert.throws(
    () => resolveOwnerOrigin(origin),
    /CYBERBASER_OWNER_ORIGIN/,
  )
}
for (const host of ["127.0.0.1", "10.255.255.254", "172.31.0.9", "192.168.0.1", "100.127.0.1"]) {
  assert.equal(isPrivateNetworkIpv4Host(host), true, host)
}
for (const host of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "127.0.0.0", "255.255.255.255", "localhost", "::1", "010.0.0.1", "127.1"]) {
  assert.equal(isPrivateNetworkIpv4Host(host), false, host)
}
assert.throws(
  () => resolveEditLinkMode("preview", undefined),
  /Unsupported CYBERBASER_EDIT_LINK_MODE: preview/,
)
for (const ciValue of ["1", "true", "TRUE", "yes"]) {
  assert.throws(
    () => resolveEditLinkMode("owner", ciValue),
    /CYBERBASER_EDIT_LINK_MODE=owner is disabled in CI/,
  )
}

console.log("edit-link unit checks passed")
