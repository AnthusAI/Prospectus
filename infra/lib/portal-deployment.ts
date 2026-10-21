import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Activation flag for Anthus One hosting (infra/portal-hosting.json). While false the backend
 * creates no portal resource and the Amplify build does not build the portal bundle.
 */
export function portalHostingDeployment(): { assetDirectory: string } | null {
  const config = JSON.parse(readFileSync(new URL("../portal-hosting.json", import.meta.url), "utf8"));
  if (typeof config.enabled !== "boolean" || Object.keys(config).length !== 1)
    throw new Error("infra/portal-hosting.json must contain only a boolean enabled flag");
  return config.enabled ? { assetDirectory: resolve("dist-portal") } : null;
}
