import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleFixture } from "./testing/google-fixture";
import { MemoryGoogleIdentities } from "./testing/memory-google-identities";
import { MemoryIdentityFiles } from "./testing/memory-identity-files";
import { FakeSiteSubjectSecret } from "./testing/fake-site-subject-secret";
import { googleIdentityHandler } from "./google-identity";
import { registrations } from "./registration";
import { papyrusSiteRegistrations, papyrusSiteRoutes } from "./papyrus-sites";
import {
  ParameterStoreSiteSubjectSecret,
  publicReaderHandler,
  RETIRED_SITE_SUBJECTS_PATH,
  siteSubject,
  siteSubjectSecretConfiguration,
  SITE_SUBJECT_PATTERN,
  type SiteSubjectSecret,
} from "./site-subjects";
import { RetiredSiteSubjects, RETIREMENT_SETTLE_SECONDS } from "./retired-site-subjects";
import type { RestEvent } from "./auth";

const HOUR = 3600;

/** Two public-reader sites (indexes 0 and 1) on the synthetic pools, or the plain editor-shaped products. */
function sites(options: { readers?: boolean; secret?: SiteSubjectSecret | null } = {}) {
  const fixture = googleFixture();
  const readers = options.readers ?? true;
  const products = registrations(
    fixture.products.map((product, index) =>
      readers
        ? { ...product, product: `papyrus-reader-${index}`, capabilities: [], audience: "public-reader" }
        : product,
    ),
  );
  const repository = new MemoryGoogleIdentities();
  const files = new MemoryIdentityFiles();
  const secret = options.secret === null ? undefined : (options.secret ?? new FakeSiteSubjectSecret());
  const inner = googleIdentityHandler(repository, products, fixture.keys, () => fixture.now);
  const retired = secret ? new RetiredSiteSubjects(files, products, secret, () => fixture.now) : undefined;
  const handler = publicReaderHandler(inner, products, secret, retired, () => fixture.now);
  const call = async (event: RestEvent) => {
    const response = await handler(event);
    return { status: response.statusCode, text: response.body, body: JSON.parse(response.body) };
  };
  const enroll = async (
    index: number,
    googleSubject = "synthetic-google-a",
    poolSubject = `synthetic-pool-person-${index}`,
  ) => {
    const challenge = await call(fixture.event(index, "/v1/identities/google/challenge"));
    assert.equal(challenge.status, 200);
    const proof = fixture.pair(
      index,
      challenge.body.nonce,
      googleSubject,
      { sub: poolSubject },
      { sub: poolSubject },
    );
    const resolved = await call(
      fixture.event(
        index,
        "/v1/identities/google/resolve",
        { challengeId: challenge.body.challengeId },
        proof,
      ),
    );
    return { resolved, proof };
  };
  const me = (index: number, proof: { access: string; id: string }) =>
    call(fixture.event(index, "/v1/identities/me", {}, proof, "GET"));
  const personId = async (index: number, poolSubject = `synthetic-pool-person-${index}`) =>
    (await repository.find(products[index].issuer, poolSubject))!.person;
  const retiredList = (index: number, since?: string, method = "GET") => {
    const event = fixture.event(index, RETIRED_SITE_SUBJECTS_PATH, {}, undefined, method);
    event.body = null;
    if (since !== undefined) event.queryStringParameters = { since };
    return call(event);
  };
  return {
    fixture,
    products,
    repository,
    files,
    secret,
    inner,
    handler,
    retired,
    call,
    enroll,
    me,
    personId,
    retiredList,
  };
}

/** Every console line written while `work` runs. */
async function capturedLogs(work: () => Promise<void>) {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods)
    console[name] = (...values: unknown[]) => void lines.push(values.map(String).join(" "));
  try {
    await work();
  } finally {
    methods.forEach((name, index) => (console[name] = originals[index]));
  }
  return lines;
}

test("the site subject is ss1_ and the unpadded base64url HMAC-SHA-256 of the domain, product and Person ID", async () => {
  const secret = new FakeSiteSubjectSecret();
  const personId = randomUUID();
  const expected =
    "ss1_" +
    createHmac("sha256", secret.key)
      .update(`prospectus-site-subject:v1\npapyrus-shipped\n${personId}`)
      .digest("base64url");
  const subject = await siteSubject(secret, "papyrus-shipped", personId);
  assert.equal(subject, expected);
  assert.match(subject, /^ss1_[A-Za-z0-9_-]{43}$/);
  for (const malformed of [
    "ss1_" + "A".repeat(42),
    "ss1_" + "A".repeat(44),
    "ss1_" + "A".repeat(42) + "=",
    "ss2_" + "A".repeat(43),
    "SS1_" + "A".repeat(43),
    "ss1_" + "A".repeat(42) + "+",
    "ss1_" + "A".repeat(42) + "/",
    personId,
  ])
    assert.ok(!SITE_SUBJECT_PATTERN.test(malformed), malformed);
  await assert.rejects(siteSubject(secret, "papyrus-shipped", "not-a-person"));
  await assert.rejects(siteSubject(secret, "Papyrus Shipped", personId));
});

test("a reader site receives only its own subject: no Person ID, creation time or Google subject in any body or log", async () => {
  const environment = sites();
  const responses: string[] = [];
  const logs = await capturedLogs(async () => {
    const { resolved, proof } = await environment.enroll(0);
    assert.equal(resolved.status, 200);
    assert.deepEqual(Object.keys(resolved.body), ["person"]);
    assert.deepEqual(Object.keys(resolved.body.person), ["siteSubject"]);
    assert.match(resolved.body.person.siteSubject, SITE_SUBJECT_PATTERN);
    responses.push(resolved.text);
    const current = await environment.me(0, proof);
    assert.equal(current.status, 200);
    responses.push(current.text);
    // Errors from reader routes carry a code and a fixed message only.
    const wrongRoute = await environment.call(
      environment.fixture.event(0, "/v1/identities/unknown", {}, proof),
    );
    assert.equal(wrongRoute.status, 404);
    assert.deepEqual(Object.keys(wrongRoute.body), ["error", "message"]);
    responses.push(wrongRoute.text);
  });
  const person = await environment.personId(0);
  const outsiderValues = [
    person.id,
    person.id.replaceAll("-", ""),
    Buffer.from(person.id).toString("base64url"),
    person.createdAt,
    "synthetic-google-a",
    "synthetic-pool-person-0",
  ];
  for (const text of [...responses, ...logs])
    for (const value of outsiderValues) assert.ok(!text.includes(value), `leaked ${value}`);
});

test("the subject is stable for a site across resolve, later /me calls and new logins", async () => {
  const environment = sites();
  const first = await environment.enroll(0);
  const again = await environment.me(0, first.proof);
  environment.fixture.advance(600);
  const second = await environment.enroll(0);
  const later = await environment.me(0, second.proof);
  const subjects = [first.resolved, again, second.resolved, later].map(
    (response) => response.body.person.siteSubject,
  );
  assert.equal(new Set(subjects).size, 1);
});

test("one Google account on two reader sites gets two unrelated subjects", async () => {
  const environment = sites();
  const one = await environment.enroll(0);
  const two = await environment.enroll(1);
  // The same Person underneath.
  assert.equal((await environment.personId(0)).id, (await environment.personId(1)).id);
  const [first, second] = [one, two].map((enrolled) => enrolled.resolved.body.person.siteSubject);
  assert.match(first, SITE_SUBJECT_PATTERN);
  assert.match(second, SITE_SUBJECT_PATTERN);
  assert.notEqual(first, second);
  // Nothing shared: the subjects have no common prefix beyond the version tag.
  assert.notEqual(first.slice(0, 8), second.slice(0, 8));
});

test("editor sites are unchanged: they still receive the Person ID and creation time", async () => {
  const wrapped = sites({ readers: false });
  const { resolved, proof } = await wrapped.enroll(0);
  assert.equal(resolved.status, 200);
  const person = await wrapped.personId(0);
  assert.deepEqual(resolved.body, { person: { id: person.id, createdAt: person.createdAt } });
  assert.deepEqual((await wrapped.me(0, proof)).body, { person });
  assert.equal((wrapped.secret as FakeSiteSubjectSecret).macs, 0);
  // Without any secret configured editor sites keep working too.
  const withoutSecret = sites({ readers: false, secret: null });
  assert.equal((await withoutSecret.enroll(0)).resolved.status, 200);
});

test("a missing or unavailable secret fails closed with 503 before any enrollment work and never falls back", async () => {
  for (const secret of [null, Object.assign(new FakeSiteSubjectSecret(), { unavailable: true })]) {
    const environment = sites({ secret });
    const challenge = await environment.call(environment.fixture.event(0, "/v1/identities/google/challenge"));
    assert.equal(challenge.status, 503);
    assert.deepEqual(Object.keys(challenge.body), ["error", "message"]);
    const proof = environment.fixture.pair(0, "synthetic-nonce");
    const resolved = await environment.call(
      environment.fixture.event(0, "/v1/identities/google/resolve", { challengeId: randomUUID() }, proof),
    );
    assert.equal(resolved.status, 503);
    assert.equal((await environment.me(0, proof)).status, 503);
    assert.equal((await environment.retiredList(0)).status, 503);
    assert.deepEqual(environment.repository.counts, {
      people: 0,
      googleIdentities: 0,
      aliases: 0,
      associations: 0,
    });
  }
  // The secret disappearing after enrollment still yields 503, not the Person ID.
  const secret = new FakeSiteSubjectSecret();
  const environment = sites({ secret });
  const { proof } = await environment.enroll(0);
  secret.unavailable = true;
  const current = await environment.me(0, proof);
  assert.equal(current.status, 503);
  assert.ok(!current.text.includes((await environment.personId(0)).id));
});

test("the Parameter Store secret is read with decryption, cached, never cached on failure and refused when short", async () => {
  const configuration = siteSubjectSecretConfiguration({
    version: "v1",
    parameterName: "/prospectus/central-accounts/site-subject/v1",
  });
  const good = Buffer.alloc(48, 7).toString("base64");
  let value: string | undefined;
  let failing = false;
  const requests: any[] = [];
  const client = {
    send: async (command: any) => {
      requests.push(command.input);
      if (failing) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
      return { Parameter: value === undefined ? undefined : { Value: value } };
    },
  };
  const secret = new ParameterStoreSiteSubjectSecret(configuration, client as never);
  for (const missing of [undefined, "not base64!", Buffer.alloc(31, 1).toString("base64")]) {
    value = missing;
    await assert.rejects(secret.ready());
  }
  failing = true;
  await assert.rejects(secret.ready());
  failing = false;
  value = good;
  await secret.ready();
  const subject = await siteSubject(secret, "papyrus-shipped", randomUUID());
  assert.match(subject, SITE_SUBJECT_PATTERN);
  const reads = requests.length;
  await secret.mac(Buffer.from("x"));
  assert.equal(requests.length, reads, "a loaded secret is cached");
  assert.ok(
    requests.every(
      (input) =>
        input.Name === "/prospectus/central-accounts/site-subject/v1" && input.WithDecryption === true,
    ),
  );
  for (const invalid of [
    undefined,
    {},
    { version: "v2", parameterName: "/prospectus/central-accounts/site-subject/v2" },
    { version: "v1", parameterName: "/prospectus/central-accounts/site-subject/v2" },
    { version: "v1", parameterName: "prospectus/site-subject/v1" },
    { version: "v1", parameterName: "/prospectus/central-accounts/site-subject/v1", extra: true },
  ])
    assert.throws(() => siteSubjectSecretConfiguration(invalid));
});

test("deleted Persons are listed as retired to their own reader site only, after the hour ends", async () => {
  const environment = sites();
  const { resolved } = await environment.enroll(0);
  const subject = resolved.body.person.siteSubject;
  const person = await environment.personId(0);
  const recorded = await environment.retired!.retirePerson({
    operationId: randomUUID(),
    personId: person.id,
    reason: "deleted",
    readerProducts: ["papyrus-reader-0"],
  });
  assert.deepEqual(
    recorded.map((record) => record.siteSubject),
    [subject],
  );
  // Not before the hour it was recorded in has ended.
  assert.deepEqual((await environment.retiredList(0)).body, { retired: [], cursor: null, more: false });
  environment.fixture.advance(HOUR + RETIREMENT_SETTLE_SECONDS);
  const listed = await environment.retiredList(0);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.retired.length, 1);
  assert.deepEqual(Object.keys(listed.body.retired[0]).sort(), ["reason", "retiredAt", "siteSubject"]);
  assert.equal(listed.body.retired[0].siteSubject, subject);
  assert.equal(listed.body.retired[0].reason, "deleted");
  assert.match(listed.body.retired[0].retiredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
  for (const value of [person.id, person.createdAt, "synthetic-google-a"])
    assert.ok(!listed.text.includes(value));
  // The other reader site sees nothing; the cursor moves forward and nothing repeats.
  assert.deepEqual((await environment.retiredList(1)).body, { retired: [], cursor: null, more: false });
  assert.deepEqual((await environment.retiredList(0, listed.body.cursor)).body, {
    retired: [],
    cursor: listed.body.cursor,
    more: false,
  });
});

test("a merge lists the surviving Person's subject on the same site so the site can remap", async () => {
  const environment = sites();
  const merged = await environment.enroll(0, "synthetic-google-merged", "synthetic-pool-merged");
  const mergedPerson = await environment.personId(0, "synthetic-pool-merged");
  const survivor = await environment.enroll(0, "synthetic-google-survivor", "synthetic-pool-survivor");
  const survivorPerson = { person: await environment.personId(0, "synthetic-pool-survivor") };
  assert.notEqual(survivorPerson.person.id, mergedPerson.id);
  await environment.retired!.retirePerson({
    operationId: randomUUID(),
    personId: mergedPerson.id,
    reason: "merged",
    survivingPersonId: survivorPerson.person.id,
    readerProducts: ["papyrus-reader-0"],
  });
  environment.fixture.advance(HOUR + RETIREMENT_SETTLE_SECONDS);
  const listed = await environment.retiredList(0);
  assert.deepEqual(listed.body.retired, [
    {
      siteSubject: merged.resolved.body.person.siteSubject,
      reason: "merged",
      survivingSiteSubject: survivor.resolved.body.person.siteSubject,
      retiredAt: listed.body.retired[0].retiredAt,
    },
  ]);
});

test("the retired list is scoped to the caller's product, paged by cursor and refused to every other caller", async () => {
  const environment = sites();
  const people = Array.from({ length: 3 }, () => randomUUID());
  for (const personId of people)
    await environment.retired!.retirePerson({
      operationId: randomUUID(),
      personId,
      reason: "deleted",
      readerProducts: ["papyrus-reader-1"],
    });
  const operationId = randomUUID();
  const retry = {
    operationId,
    personId: people[0],
    reason: "deleted" as const,
    readerProducts: ["papyrus-reader-1"],
  };
  await environment.retired!.retirePerson(retry);
  environment.fixture.advance(HOUR + RETIREMENT_SETTLE_SECONDS);
  const later = randomUUID();
  await environment.retired!.retirePerson({
    operationId: randomUUID(),
    personId: later,
    reason: "deleted",
    readerProducts: ["papyrus-reader-1"],
  });
  const first = await environment.retiredList(1);
  const expected = await Promise.all(
    people.map((personId) => siteSubject(environment.secret!, "papyrus-reader-1", personId)),
  );
  // The retried retirement of the same subject in the same hour is one record.
  assert.deepEqual(first.body.retired.map((record: any) => record.siteSubject).sort(), expected.sort());
  assert.deepEqual((await environment.retiredList(0)).body.retired, []);
  environment.fixture.advance(HOUR);
  const next = await environment.retiredList(1, first.body.cursor);
  assert.deepEqual(
    next.body.retired.map((record: any) => record.siteSubject),
    [await siteSubject(environment.secret!, "papyrus-reader-1", later)],
  );
  // Editor sites and unregistered callers are refused.
  const editors = sites({ readers: false });
  const editorCall = await editors.retiredList(0);
  assert.equal(editorCall.status, 403);
  // Malformed requests.
  assert.equal((await environment.retiredList(1, "not-a-cursor")).status, 400);
  assert.equal((await environment.retiredList(1, undefined, "POST")).status, 404);
  const extra = environment.fixture.event(1, RETIRED_SITE_SUBJECTS_PATH, {}, undefined, "GET");
  extra.body = null;
  extra.queryStringParameters = { since: first.body.cursor, product: "papyrus-reader-0" };
  assert.equal((await environment.call(extra)).status, 400);
});

test("retirement requests name registered reader sites and a well-formed reason", async () => {
  const environment = sites();
  const personId = randomUUID();
  for (const invalid of [
    { operationId: "x", personId, reason: "deleted", readerProducts: ["papyrus-reader-0"] },
    { operationId: randomUUID(), personId, reason: "deleted", readerProducts: [] },
    { operationId: randomUUID(), personId, reason: "deleted", readerProducts: ["papyrus-unknown"] },
    {
      operationId: randomUUID(),
      personId,
      reason: "deleted",
      readerProducts: ["papyrus-reader-0", "papyrus-reader-0"],
    },
    { operationId: randomUUID(), personId, reason: "merged", readerProducts: ["papyrus-reader-0"] },
    {
      operationId: randomUUID(),
      personId,
      reason: "merged",
      survivingPersonId: personId,
      readerProducts: ["papyrus-reader-0"],
    },
    {
      operationId: randomUUID(),
      personId,
      reason: "deleted",
      survivingPersonId: randomUUID(),
      readerProducts: ["papyrus-reader-0"],
    },
    { operationId: randomUUID(), personId, reason: "expired", readerProducts: ["papyrus-reader-0"] },
  ])
    await assert.rejects(environment.retired!.retirePerson(invalid as never));
  const editors = sites({ readers: false });
  await assert.rejects(
    editors.retired!.retirePerson({
      operationId: randomUUID(),
      personId,
      reason: "deleted",
      readerProducts: ["cyclotron"],
    }),
  );
});

test("the registered Shipped site is a public reader and the retired route needs no new access-policy entry", () => {
  const [shipped] = papyrusSiteRegistrations([
    {
      audience: "public-reader",
      clientId: "syntheticshipped",
      federationReviewId: "synthetic-shipped-google-only",
      issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticShipped",
      product: "papyrus-shipped",
      roleArn: "arn:aws:iam::111111111111:role/SyntheticShipped",
      siteReviewId: "synthetic-shipped-site",
    },
  ]);
  assert.equal(shipped.audience, "public-reader");
  // The retired route reuses the existing GET/v1/accounts/* pattern: no new access-policy entry.
  assert.equal(papyrusSiteRoutes.length, 8);
  assert.equal(RETIRED_SITE_SUBJECTS_PATH, "/v1/accounts/site-subjects/retired");
  assert.ok(papyrusSiteRoutes.includes("GET/v1/accounts/*"));
  assert.throws(() => registrations([{ ...shipped, capabilities: ["console:read"] }]));
  assert.throws(() => registrations([{ ...shipped, audience: "editor" as never }]));
});
