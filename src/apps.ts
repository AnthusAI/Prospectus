/** Anthus apps as customers and staff see them. Logos are the products' own, with sources recorded in public/brand/SOURCES.md. */
export interface AnthusApp {
  id: string;
  name: string;
  /** The product's own logo, one file per theme. Absent when none may be shipped; a neutral mark shows instead. */
  logo?: { light: string; dark: string; plate?: boolean };
  /** Public address customers open, when the app has one. */
  url?: string;
  blurb?: string;
}

/**
 * Identifiers that older accounts, entitlements and stored prospects still hold, mapped to the app that replaced
 * them. Auritus was merged into Babulus on 2026-11-02 (Babulus epic babulus-d22d6854). Stored data is not rewritten.
 */
export const FORMER_APP_IDS: Readonly<Record<string, string>> = { auritus: "babulus" };

/**
 * The one place the order of products is written: every console and portal list follows it. Products are ordered by
 * how likely they are to sell, so expect this order to change; change it here and nowhere else.
 */
export const ANTHUS_APPS: readonly AnthusApp[] = [
  {
    id: "papyrus",
    name: "Papyrus",
    logo: { light: "/brand/papyrus.svg", dark: "/brand/papyrus.svg" },
    url: "https://p.apyr.us",
    blurb: "An automated newsroom: agents watch your beat, your editors decide what publishes.",
  },
  {
    id: "cyclotron",
    name: "Cyclotron",
    logo: { light: "/brand/cyclotron.svg", dark: "/brand/cyclotron.svg" },
    url: "https://lab.cyclotron.anth.us",
    blurb: "One AI decision that learns from your team’s corrections.",
  },
  {
    id: "chatticus",
    name: "Chatticus",
    logo: { light: "/brand/chatticus.svg", dark: "/brand/chatticus.svg" },
    url: "https://chattic.us",
    blurb: "Shared rooms where people and bots work together, with approvals.",
  },
  {
    id: "babulus",
    name: "Babulus",
    // Babulus has no logo of its own; Ryan chose the Auritus mascot on 2026-11-05. Transparent art, so it sits on a plate.
    logo: { light: "/brand/babulus.png", dark: "/brand/babulus.png", plate: true },
    url: "https://babul.us",
    blurb: "Voiceover and video made on your own machine first, in the cloud only when it is allowed.",
  },
  {
    id: "kanbus",
    name: "Kanbus",
    logo: { light: "/brand/kanbus.svg", dark: "/brand/kanbus.svg" },
    url: "https://kanb.us",
    blurb: "Durable task boards for teams of people and agents.",
  },
  { id: "apricity", name: "Apricity" },
  { id: "services", name: "Professional services" },
];

/** The current id for a possibly former one: auritus is babulus. */
export function canonicalAppId(id: string): string {
  return Object.hasOwn(FORMER_APP_IDS, id) ? FORMER_APP_IDS[id] : id;
}

/** Sort products (ids such as `papyrus-p-apyr-us`) into catalog order. Stable; unknown products go last. */
export function byAppOrder<T>(items: readonly T[], product: (item: T) => string): T[] {
  const rank = (item: T) => {
    const id = appForProduct(product(item)).id;
    const index = ANTHUS_APPS.findIndex((app) => app.id === id);
    return index < 0 ? ANTHUS_APPS.length : index;
  };
  return items
    .map((item, position) => ({ item, position, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.position - b.position)
    .map(({ item }) => item);
}

/** Papyrus sites whose host is not their product name: the `siteUrl` entries of accounts/papyrus-sites.json. */
export const PAPYRUS_SITE_URLS: Readonly<Record<string, string>> = {
  "papyrus-dataparade": "https://dataparade.anth.us",
  "papyrus-machines-on-machines": "https://machines-on-machines.anth.us",
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
  // A former id such as `auritus` or `auritus-example-com` is shown as the app that replaced it.
  const former = Object.keys(FORMER_APP_IDS).find((id) => product === id || product.startsWith(`${id}-`));
  const name = former ? FORMER_APP_IDS[former] : product;
  return (
    ANTHUS_APPS.find((app) => name === app.id || name.startsWith(`${app.id}-`)) ?? {
      id: product,
      name: product,
    }
  );
}

export function appById(id: string): AnthusApp | undefined {
  const current = canonicalAppId(id);
  return ANTHUS_APPS.find((app) => app.id === current);
}

/**
 * Products an operator can turn on or off for an Account. There is no registry the UI can read yet, so this
 * is the list registered centrally today (Cyclotron, Babulus and the Papyrus sites of accounts/papyrus-sites.json).
 * A product missing here still shows when the Account already holds it, and central refuses an unregistered one.
 */
export const OPERATOR_PRODUCTS: readonly string[] = byAppOrder(
  [
    "babulus",
    "cyclotron",
    "papyrus-dataparade",
    "papyrus-machines-on-machines",
    "papyrus-p-apyr-us",
    "papyrus-pilobol-us",
    "papyrus-shipped",
  ],
  (product) => product,
);
