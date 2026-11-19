/**
 * Pure parts of the vault appearance plugin (VaultAppearance.ts): the
 * stylesheet's published file name and the default color scheme script.
 * Copied into `<quartz>/quartz/cyberbase/` by setup.sh.
 */
import { createHash } from "crypto"

export type ColorScheme = "system" | "dark" | "light"

/** Content-addressed name, so a changed stylesheet is never served stale from a cache. */
export function stylesheetSlug(cssText: string): string {
  return `static/site-${createHash("sha256").update(cssText).digest("hex").slice(0, 12)}`
}

/** Content-addressed name for the site icon. */
export function faviconSlug(bytes: Uint8Array): string {
  return `static/site-icon-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`
}

/** PNG signature check, so a renamed file of another type fails the build. */
export function isPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return bytes.length > sig.length && sig.every((b, i) => bytes[i] === b)
}

/**
 * Runs in <head> right after Quartz's prescript, which has already applied the
 * reader's saved choice or the device preference. Without a saved choice, the
 * site's default replaces the device preference. The reader's toggle still wins.
 */
export function colorSchemeScript(scheme: ColorScheme): string | undefined {
  if (scheme === "system") return undefined
  return `(()=>{try{if(localStorage.getItem("theme"))return}catch(e){}document.documentElement.setAttribute("saved-theme",${JSON.stringify(scheme)})})()`
}
