import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleFixture } from "./testing/google-fixture";
import { FakeSiteSubjectSecret } from "./testing/fake-site-subject-secret";
import { canonicalAccountsHandler } from "./canonical-handler";
import { VirtuusAccountFiles, VirtuusIdentityFiles } from "./identity-files";
import { registrations } from "./registration";
import { RETIRED_SITE_SUBJECTS_PATH, SITE_SUBJECT_PATTERN, type SiteSubjectSecret } from "./site-subjects";
import { RetiredSiteSubjects, RETIREMENT_SETTLE_SECONDS } from "./retired-site-subjects";
import type { RestEvent } from "./auth";

/** Real Virtuus files in a disposable directory: the production storage code and the central composition. */
test("persisted: a reader site sees only pairwise subjects through every route, and retirements persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "site-subjects-"));
  try {
    const fixture = googleFixture();
    const products = registrations([
      { ...fixture.products[0], product: "papyrus-editor" },
      { ...fixture.products[1], product: "papyrus-reader", capabilities: [], audience: "public-reader" },
    ]);
    const secret = new FakeSiteSubjectSecret();
    const handler = (siteSubjectSecret: SiteSubjectSecret | null = secret) =>
      canonicalAccountsHandler(
        new VirtuusIdentityFiles(root),
        new VirtuusAccountFiles(root),
        products,
        fixture.keys,
        () => fixture.now,
        [],
        "scan",
        undefined,
        {},
        siteSubjectSecret ?? undefined,
      );
    const call = async (event: RestEvent, siteSubjectSecret: SiteSubjectSecret | null = secret) => {
      const response = await handler(siteSubjectSecret)(event);
      return { status: response.statusCode, text: response.body, body: JSON.parse(response.body) };
    };
    const enroll = async (index: number) => {
      const challenge = await call(fixture.event(index, "/v1/identities/google/challenge"));
      assert.equal(challenge.status, 200, challenge.text);
      const proof = fixture.pair(index, challenge.body.nonce, "synthetic-google-durable");
      const resolved = await call(
        fixture.event(
          index,
          "/v1/identities/google/resolve",
          { challengeId: challenge.body.challengeId },
          proof,
        ),
      );
      assert.equal(resolved.status, 200, resolved.text);
      return { proof, resolved };
    };
    const editor = await enroll(0);
    const person = editor.resolved.body.person;
    assert.ok(person.id && person.createdAt);
    const reader = await enroll(1);
    const subject = reader.resolved.body.person.siteSubject;
    assert.match(subject, SITE_SUBJECT_PATTERN);
    assert.deepEqual(reader.resolved.body, { person: { siteSubject: subject } });

    const readerBodies = [reader.resolved.text];
    const me = await call(fixture.event(1, "/v1/identities/me", {}, reader.proof, "GET"));
    assert.deepEqual(me.body, { person: { siteSubject: subject } });
    const accounts = await call(fixture.event(1, "/v1/accounts", {}, reader.proof, "GET"));
    assert.deepEqual(accounts.body, { person: { siteSubject: subject }, accounts: [] });
    const directory = await call(fixture.event(1, "/v1/account-directory", {}, reader.proof, "GET"));
    assert.equal(directory.status, 403);
    const authorize = await call(
      fixture.event(1, `/v1/accounts/${randomUUID()}/authorize`, { operation: "console:read" }, reader.proof),
    );
    assert.equal(authorize.status, 403);
    readerBodies.push(me.text, accounts.text, directory.text, authorize.text);
    for (const text of readerBodies)
      for (const value of [
        person.id,
        person.createdAt,
        "synthetic-google-durable",
        "synthetic-pool-person-1",
      ])
        assert.ok(!text.includes(value), `reader response leaked ${value}`);

    // Editor sites are unchanged.
    const editorMe = await call(fixture.event(0, "/v1/identities/me", {}, editor.proof, "GET"));
    assert.deepEqual(editorMe.body, { person });

    // Without the secret the reader fails closed and the editor is unaffected.
    const closed = await handler(null)(fixture.event(1, "/v1/identities/me", {}, reader.proof, "GET"));
    assert.equal(closed.statusCode, 503);
    assert.ok(!closed.body.includes(person.id));
    assert.equal(
      (await handler(null)(fixture.event(0, "/v1/identities/me", {}, editor.proof, "GET"))).statusCode,
      200,
    );

    // A deletion is recorded in the identities project and listed to the reader site after its hour ends.
    const retirements = new RetiredSiteSubjects(
      new VirtuusIdentityFiles(root),
      products,
      secret,
      () => fixture.now,
    );
    const operationId = randomUUID();
    const retirement = {
      operationId,
      personId: person.id,
      reason: "deleted" as const,
      readerProducts: ["papyrus-reader"],
    };
    await retirements.retirePerson(retirement);
    await retirements.retirePerson(retirement);
    const files = await new VirtuusIdentityFiles(root).list("retired-subjects/");
    assert.equal(files.length, 1, "an identical retry is one record");
    fixture.advance(3600 + RETIREMENT_SETTLE_SECONDS);
    const listEvent = (index: number) => {
      const event = fixture.event(index, RETIRED_SITE_SUBJECTS_PATH, {}, undefined, "GET");
      event.body = null;
      return event;
    };
    const listed = await call(listEvent(1));
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(
      listed.body.retired.map((record: any) => [record.siteSubject, record.reason]),
      [[subject, "deleted"]],
    );
    assert.ok(!listed.text.includes(person.id));
    assert.equal((await call(listEvent(0))).status, 403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
