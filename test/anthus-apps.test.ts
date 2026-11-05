import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { ANTHUS_APPS, appById, appForProduct, byAppOrder, productUrl } from "../src/apps";
import { prospectInterests } from "../src/prospect";

// features/anthus-products.feature

test("the catalog keeps every product and lists no Auritus; its order is written only in ANTHUS_APPS", () => {
  assert.deepEqual(ANTHUS_APPS.map((app) => app.id).sort(), [
    "apricity",
    "babulus",
    "chatticus",
    "cyclotron",
    "kanbus",
    "papyrus",
    "services",
  ]);
});

test("Auritus is not listed; Babulus is the one combined product at babul.us", () => {
  assert.equal(appById("auritus")?.id, "babulus");
  assert.equal(ANTHUS_APPS.filter((app) => /auritus/i.test(`${app.id} ${app.name}`)).length, 0);
  const babulus = ANTHUS_APPS.find((app) => app.id === "babulus")!;
  assert.equal(babulus.name, "Babulus");
  assert.equal(babulus.url, "https://babul.us");
  assert.match(babulus.blurb ?? "", /Voiceover and video/);
});

test("older auritus product ids still display as Babulus and open babul.us", () => {
  for (const product of ["auritus", "auritus-example-com"]) {
    assert.equal(appForProduct(product).name, "Babulus");
    assert.equal(productUrl(product), "https://babul.us");
  }
  assert.equal(appForProduct("unknown-thing").name, "unknown-thing");
});

test("a stored auritus interest reads as babulus once and is not rewritten", () => {
  const stored = ["auritus", "papyrus", "babulus"];
  const issue = { custom: { interests: stored } } as never;
  assert.deepEqual(prospectInterests(issue), ["babulus", "papyrus"]);
  assert.deepEqual(stored, ["auritus", "papyrus", "babulus"]);
});

test("byAppOrder follows the catalog order, groups Papyrus sites, keeps unknown ones last and is stable", () => {
  const ids = ANTHUS_APPS.map((app) => app.id);
  const sorted = byAppOrder(
    [...ids]
      .reverse()
      .map((id) => (id === "papyrus" ? "papyrus-shipped" : id))
      .concat(["zzz", "papyrus-dataparade", "aaa", "auritus"]),
    (item) => item,
  );
  const names = sorted.map((item) => appForProduct(item).id);
  assert.deepEqual(
    names.filter((id) => ids.includes(id)).filter((id, i, all) => all.indexOf(id) === i),
    ids,
  );
  assert.deepEqual(sorted.slice(-2), ["zzz", "aaa"]);
  assert.ok(sorted.indexOf("papyrus-shipped") < sorted.indexOf("papyrus-dataparade"), "stable within an app");
});

test("every shipped logo exists and has a recorded source; only Apricity and services lack one", () => {
  const sources = readFileSync("public/brand/SOURCES.md", "utf8");
  const files = readdirSync("public/brand").filter((name) => name !== "SOURCES.md");
  for (const file of files) assert.ok(sources.includes(file), `${file} has no recorded source`);
  const referenced = new Set<string>();
  for (const app of ANTHUS_APPS)
    if (app.logo)
      for (const path of [app.logo.light, app.logo.dark]) {
        assert.ok(path.startsWith("/brand/") && existsSync(`public${path}`), `${app.id}: ${path}`);
        referenced.add(path.slice("/brand/".length));
      }
  assert.deepEqual(
    [...referenced].sort(),
    files.sort(),
    "every file is used and every logo is a shipped file",
  );
  // Apricity has no logo file in its web repository; Professional services is not a product with a logo.
  for (const id of ["papyrus", "cyclotron", "chatticus", "babulus", "kanbus"])
    assert.ok(ANTHUS_APPS.find((app) => app.id === id)!.logo, id);
  for (const id of ["apricity", "services"])
    assert.equal(ANTHUS_APPS.find((app) => app.id === id)!.logo, undefined, id);
  for (const file of files)
    assert.doesNotMatch(
      readFileSync(`public/brand/${file}`).toString("latin1"),
      /eXIf|tEXt|iTXt|\/Users\//,
      `${file} carries metadata`,
    );
});

test("intake validation never depends on the product catalog", () => {
  for (const file of readdirSync("server").filter((name) => name.endsWith(".ts")))
    assert.doesNotMatch(readFileSync(`server/${file}`, "utf8"), /src\/apps/, file);
});
