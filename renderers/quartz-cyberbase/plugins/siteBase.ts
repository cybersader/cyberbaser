/** Path prefix of a Quartz baseUrl: "" at a domain root, "/docs" for host/docs. */
export function siteBasePath(baseUrl: string): string {
  const slash = baseUrl.indexOf("/")
  return slash < 0 ? "" : baseUrl.slice(slash)
}
