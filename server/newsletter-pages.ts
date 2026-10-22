import type { NewsletterListConfig } from "./intake-forms";

/** A minimal, accessible HTML page served by the intake API for confirm and unsubscribe links. */
export interface NewsletterPage {
  status: number;
  title: string;
  paragraphs: string[];
  /** A single button that posts back to the same URL (the token stays in the query string). */
  button?: string;
  list?: NewsletterListConfig;
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

/** Security headers: no scripts, no framing, no referrer (the URL carries a token), never cached or indexed. */
export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export function renderPage(page: NewsletterPage, postAction?: string): string {
  const name = page.list?.name;
  const heading = name ? `${name} newsletter` : "Newsletter";
  const links = page.list
    ? `<nav aria-label="${escape(name!)}"><a href="${escape(page.list.siteUrl)}">${escape(name!)}</a> · <a href="${escape(page.list.privacyUrl)}">Privacy</a></nav>`
    : "";
  const button =
    page.button && postAction
      ? `<form method="post" action="${escape(postAction)}"><button type="submit">${escape(page.button)}</button></form>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(page.title)} · ${escape(heading)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fff;--muted:#5b5b60;--accent:#1f4fd6;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#f2f2f4;--bg:#16161a;--muted:#b4b4bb;--accent:#8fb0ff;--accent-fg:#0b0b0f}}
body{margin:0;background:var(--bg);color:var(--fg);font:1.0625rem/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:0 auto;padding:3rem 1rem}
p.list{color:var(--muted);margin:0 0 .5rem;font-size:.9375rem}
h1{font-size:1.625rem;line-height:1.25;margin:0 0 1rem}
a{color:var(--accent)}
button{font:inherit;font-weight:600;padding:.75rem 1.25rem;border:0;border-radius:.5rem;background:var(--accent);color:var(--accent-fg);cursor:pointer;min-height:44px}
button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
nav{margin-top:2.5rem;color:var(--muted);font-size:.9375rem}
</style>
</head>
<body>
<main>
<p class="list">${escape(heading)}</p>
<h1>${escape(page.title)}</h1>
${page.paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("\n")}
${button}
${links}
</main>
</body>
</html>
`;
}
