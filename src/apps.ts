/** Anthus apps as customers and staff see them. Swatches are theme tokens defined in styles.css. */
export interface AnthusApp {
  id: string;
  name: string;
  swatch: string;
  /** Public address customers open, when the app has one. */
  url?: string;
  blurb?: string;
}

export const ANTHUS_APPS: readonly AnthusApp[] = [
  {
    id: "chatticus",
    name: "Chatticus",
    swatch: "var(--s1)",
    url: "https://chattic.us",
    blurb: "Shared rooms where people and bots work together, with approvals.",
  },
  {
    id: "cyclotron",
    name: "Cyclotron",
    swatch: "var(--s2)",
    url: "https://lab.cyclotron.anth.us",
    blurb: "One AI decision that learns from your team’s corrections.",
  },
  {
    id: "papyrus",
    name: "Papyrus",
    swatch: "var(--s3)",
    url: "https://p.apyr.us",
    blurb: "An automated newsroom: agents watch your beat, your editors decide what publishes.",
  },
  {
    id: "auritus",
    name: "Auritus",
    swatch: "var(--s4)",
    url: "https://aurit.us",
    blurb: "Every page on your site, read aloud on demand.",
  },
  {
    id: "kanbus",
    name: "Kanbus",
    swatch: "var(--s5)",
    url: "https://kanb.us",
    blurb: "Durable task boards for teams of people and agents.",
  },
  { id: "apricity", name: "Apricity", swatch: "var(--s6)" },
  { id: "services", name: "Professional services", swatch: "var(--accent)" },
];

/** Papyrus sites whose host is not their product name: the `siteUrl` entries of accounts/papyrus-sites.json. */
export const PAPYRUS_SITE_URLS: Readonly<Record<string, string>> = {
  "papyrus-dataparade": "https://dataparade.anth.us",
};

/**
 * Where a workspace opens a product. Papyrus products are per site (`papyrus-p-apyr-us` is p.apyr.us, unless
 * PAPYRUS_SITE_URLS names the site); other products open their app's public address.
 */
export function productUrl(product: string): string | undefined {
  if (Object.hasOwn(PAPYRUS_SITE_URLS, product)) return PAPYRUS_SITE_URLS[product];
  const site = /^papyrus-([a-z0-9-]+)$/.exec(product)?.[1];
  if (site) return `https://${site.replace(/-/g, ".")}`;
  return appForProduct(product).url;
}

/** Account products are per-site identifiers such as `papyrus-p-apyr-us`; the app is the leading name. */
export function appForProduct(product: string): AnthusApp {
  return (
    ANTHUS_APPS.find((app) => product === app.id || product.startsWith(`${app.id}-`)) ?? {
      id: product,
      name: product,
      swatch: "var(--panel-2)",
    }
  );
}

export function appById(id: string): AnthusApp | undefined {
  return ANTHUS_APPS.find((app) => app.id === id);
}
