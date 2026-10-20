import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import test from "node:test";
import { productUrl } from "../src/apps";

/** Every module the portal entry reaches, following relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, path] of readFileSync(file, "utf8").matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
      const base = resolve(dirname(file), path);
      const candidate = [base, `${base}.ts`, `${base}.tsx`].find((name) => {
        try {
          return readFileSync(name) && /\.(ts|tsx)$/.test(name);
        } catch {
          return false;
        }
      });
      if (candidate) queue.push(candidate);
    }
  }
  return seen;
}

test("the portal is a separate application that never reaches staff console code", () => {
  const portal = [...reachable("src/portal/main.tsx")].map((file) => file.replace(`${process.cwd()}/`, ""));
  for (const forbidden of [
    "src/App.tsx",
    "src/AccountsView.tsx",
    "src/admin/",
    "src/client.ts",
    "src/IntakeForm.tsx",
  ])
    assert.ok(!portal.some((file) => file.startsWith(forbidden)), `portal reaches ${forbidden}`);
  const staff = [...reachable("src/main.tsx")].map((file) => file.replace(`${process.cwd()}/`, ""));
  assert.ok(!staff.some((file) => file.startsWith("src/portal/")), "staff console reaches portal code");
  assert.ok(readdirSync("portal").includes("index.html"));
});

test("workspace products open their own sites", () => {
  assert.equal(productUrl("papyrus-p-apyr-us"), "https://p.apyr.us");
  assert.equal(productUrl("papyrus-pilobol-us"), "https://pilobol.us");
  assert.equal(productUrl("cyclotron"), "https://lab.cyclotron.anth.us");
  assert.equal(productUrl("unknown-product"), undefined);
});
