import { readFileSync } from "fs"
import path from "path"
import yaml from "js-yaml"
import { parseSiteConfig, type SiteConfig } from "./siteConfig"

let cached: SiteConfig | undefined
/** Settings for this build: the YAML file named by CYBERBASER_SITE_CONFIG, or neutral defaults. */
export function loadSiteConfig(env: Record<string, string | undefined> = process.env): SiteConfig {
  if (cached) return cached
  const file = env.CYBERBASER_SITE_CONFIG
  cached = file
    ? parseSiteConfig(yaml.load(readFileSync(file, "utf8")), path.dirname(path.resolve(file)), env)
    : parseSiteConfig({}, ".", env)
  return cached
}
