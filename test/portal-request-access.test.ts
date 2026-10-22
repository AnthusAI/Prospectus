import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { REQUEST_ACCESS_URL, WorkspaceUnavailableNote } from "../src/portal/RequestAccess";

test("Request access goes to the Anth.us contact page with the solution and location named", () => {
  assert.equal(REQUEST_ACCESS_URL, "https://anth.us/engage/?solution=Anthus%20One&cta=portal");
});

test("the unavailable note renders a plain Request access link, not a script-opened window", () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceUnavailableNote, {
      heading: "New to Anthus?",
      children: "Creating a workspace here is not yet available.",
    }),
  );
  assert.match(html, /role="note"/);
  assert.match(
    html,
    /<a [^>]*href="https:\/\/anth\.us\/engage\/\?solution=Anthus%20One&amp;cta=portal"[^>]*>Request access<\/a>/,
  );
  assert.doesNotMatch(html, /onclick|window\.open/i);
});

test("both the signed-out landing and the no-workspace state use the note, and neither hand-rolls one", () => {
  const source = readFileSync("src/portal/PortalApp.tsx", "utf8");
  assert.equal(source.match(/<WorkspaceUnavailableNote/g)?.length, 2);
  assert.match(source, /<WorkspaceUnavailableNote heading="New to Anthus\?">/);
  assert.match(
    source,
    /<WorkspaceUnavailableNote heading="Creating a workspace here is not yet available\.">/,
  );
  assert.doesNotMatch(source, /className="one-unavailable"/);
});
