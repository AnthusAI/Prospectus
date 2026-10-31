import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PAPYRUS_SITE_URLS, productUrl } from "../src/apps";

const IMPORT_PATTERNS = [
  /\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
];

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx"].map((extension) => `${base}${extension}`),
    ...[".ts", ".tsx"].map((extension) => resolve(base, `index${extension}`)),
  ];
  return candidates.find((name) => /\.(ts|tsx)$/.test(name) && existsSync(name) && statSync(name).isFile());
}

/** Every module an entry reaches through relative static, dynamic, side-effect and directory-index imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const pattern of IMPORT_PATTERNS)
      for (const [, specifier] of source.matchAll(pattern)) {
        if (!specifier.startsWith(".")) continue;
        const module = resolveModule(file, specifier);
        if (module) queue.push(module);
      }
  }
  return seen;
}

const relative = (files: Set<string>) => [...files].map((file) => file.replace(`${process.cwd()}/`, ""));

test("import resolution follows dynamic, side-effect and directory index imports", () => {
  const directory = mkdtempSync(join(tmpdir(), "separation-"));
  mkdirSync(join(directory, "folder"));
  writeFileSync(join(directory, "folder/index.tsx"), "export {};");
  writeFileSync(join(directory, "entry.ts"), "");
  const source = (text: string) =>
    [...IMPORT_PATTERNS].flatMap((p) => [...text.matchAll(p)].map((m) => m[1]));
  assert.deepEqual(source('import("./lazy")'), ["./lazy"]);
  assert.deepEqual(source('import "./effects"'), ["./effects"]);
  assert.deepEqual(source('export * from "./barrel"'), ["./barrel"]);
  assert.deepEqual(source('import { a,\n b } from "../x"'), ["../x"]);
  assert.equal(resolveModule(join(directory, "entry.ts"), "./folder"), join(directory, "folder/index.tsx"));
  rmSync(directory, { recursive: true, force: true });
});

test("the portal is a separate application that never reaches staff console code", () => {
  const portal = relative(reachable("src/portal/main.tsx"));
  for (const forbidden of [
    "src/App.tsx",
    "src/AccountsView.tsx",
    "src/admin/",
    "src/client.ts",
    "src/IntakeForm.tsx",
    "src/main.tsx",
  ])
    assert.ok(!portal.some((file) => file.startsWith(forbidden)), `portal reaches ${forbidden}`);
  const staff = relative(reachable("src/main.tsx"));
  assert.ok(!staff.some((file) => file.startsWith("src/portal/")), "staff console reaches portal code");
  assert.ok(readdirSync("portal").includes("index.html"));
});

test("workspace products open their own sites", () => {
  assert.equal(productUrl("papyrus-p-apyr-us"), "https://p.apyr.us");
  assert.equal(productUrl("papyrus-pilobol-us"), "https://pilobol.us");
  assert.equal(productUrl("papyrus-dataparade"), "https://dataparade.anth.us");
  assert.equal(productUrl("cyclotron"), "https://lab.cyclotron.anth.us");
  assert.equal(productUrl("unknown-product"), undefined);
});

test("the portal's Papyrus site URLs are exactly the registry's siteUrl entries", () => {
  const sites = JSON.parse(readFileSync("accounts/papyrus-sites.json", "utf8")) as {
    product: string;
    siteUrl?: string;
  }[];
  assert.deepEqual(
    PAPYRUS_SITE_URLS,
    Object.fromEntries(sites.filter((site) => site.siteUrl).map((site) => [site.product, site.siteUrl])),
  );
});
