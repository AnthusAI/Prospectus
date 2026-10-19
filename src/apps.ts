/** Anthus apps as customers and staff see them. Swatches are theme tokens defined in styles.css. */
export interface AnthusApp {
  id: string;
  name: string;
  swatch: string;
}

export const ANTHUS_APPS: readonly AnthusApp[] = [
  { id: "chatticus", name: "Chatticus", swatch: "var(--s1)" },
  { id: "cyclotron", name: "Cyclotron", swatch: "var(--s2)" },
  { id: "papyrus", name: "Papyrus", swatch: "var(--s3)" },
  { id: "auritus", name: "Auritus", swatch: "var(--s4)" },
  { id: "kanbus", name: "Kanbus", swatch: "var(--s5)" },
  { id: "apricity", name: "Apricity", swatch: "var(--s6)" },
  { id: "services", name: "Professional services", swatch: "var(--accent)" },
];

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
