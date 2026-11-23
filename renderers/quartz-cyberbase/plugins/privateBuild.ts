// Owner-private builds make no network requests at build time and link no
// third-party font or math CDNs. Public builds are left exactly as configured.
import fs from "node:fs";
import path from "node:path";

/**
 * A build is owner-private when its edit links point at the owner app
 * (CYBERBASER_EDIT_LINK_MODE=owner). build.sh already refuses that mode in CI,
 * so the public site build can never take this branch.
 */
export function privateBuildMode(env: Record<string, string | undefined>): boolean {
  return env.CYBERBASER_EDIT_LINK_MODE === "owner";
}

/** Social-image generation fetches Google fonts; private builds never need it. */
export const PRIVATE_BUILD_DROPPED_EMITTERS = Object.freeze(["CustomOgImages"]);

function localKatexCss(quartzDir: string): string | null {
  try {
    const css = fs.readFileSync(
      path.join(quartzDir, "node_modules/katex/dist/katex.min.css"),
      "utf8",
    );
    // Font files are not copied; drop their remote-or-missing @font-face rules
    // so math falls back to local fonts instead of requesting files.
    return css.replace(/@font-face\{[^}]*\}/g, "");
  } catch {
    return null;
  }
}

/**
 * Rewrite one Quartz config for an owner-private build, in place:
 * - fonts: declared families with the system stack behind them, no Google fetch or link;
 * - no CustomOgImages emitter (it downloads fonts to draw social cards);
 * - KaTeX: the pinned package's stylesheet inlined instead of the jsDelivr links.
 */
export function applyPrivateBuild(config: any, quartzDir: string = process.cwd()) {
  const theme = config.configuration.theme;
  config.configuration.theme = { ...theme, fontOrigin: "local", cdnCaching: false };
  config.plugins.emitters = config.plugins.emitters.filter(
    (emitter: any) => !PRIVATE_BUILD_DROPPED_EMITTERS.includes(emitter.name),
  );
  config.plugins.transformers = config.plugins.transformers.map((plugin: any) => {
    if (plugin.name !== "Latex" || !plugin.externalResources) return plugin;
    const css = localKatexCss(quartzDir);
    return {
      ...plugin,
      externalResources() {
        return { css: css === null ? [] : [{ content: css, inline: true }], js: [] };
      },
    };
  });
  return config;
}
