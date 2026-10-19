import { operatorSubjectHash } from "./operator-policy";
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { directoryFixture } from "./testing/directory-fixture";
import { canonicalAccountsHandler } from "./canonical-handler";
import { VirtuusIdentityFiles, VirtuusAccountFiles } from "./identity-files";
import { accountsBffHandler } from "./bff";
import { AccountsClient, decode } from "../packages/accounts-client/src/client";
test("canonical directory filters organizations by membership, never CRM admin or product alone", async () => {
  const environment = await directoryFixture();
  try {
    const request = (actor: typeof environment.ownerDirectory, path: string) =>
      environment.handler()(environment.identityFixture.event(actor.index, path, {}, actor.proof, "GET"));
    const listed = await request(environment.ownerDirectory, "/v1/account-directory");
    assert.equal(listed.statusCode, 200);
    assert.equal(JSON.parse(listed.body).accounts[0].id, environment.account.id);
    assert.equal(JSON.parse(listed.body).accounts[0].products[0].product, "papyrus");
    assert.deepEqual(
      JSON.parse((await request(environment.outsider, "/v1/account-directory")).body).accounts,
      [],
    );
    assert.equal(
      (await request(environment.outsider, `/v1/account-directory/${environment.account.id}`)).statusCode,
      403,
    );
    assert.equal(
      (await request(environment.owner, `/v1/account-directory/${environment.account.id}`)).statusCode,
      403,
    ); // normal console runtime cannot use directory routes
    assert.equal(
      (await request(environment.ownerDirectory, `/v1/accounts/${environment.account.id}`)).statusCode,
      403,
    ); // directory visibility grants no product entitlement
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
test("owner and admin see memberships; members and viewers see only themselves; restart and revocation persist", async () => {
  const environment = await directoryFixture();
  try {
    const detail = async (actor: typeof environment.ownerDirectory) => {
      const response = await environment.handler()(
        environment.identityFixture.event(
          actor.index,
          `/v1/account-directory/${environment.account.id}`,
          {},
          actor.proof,
          "GET",
        ),
      );
      assert.equal(response.statusCode, 200);
      return JSON.parse(response.body).account;
    };
    assert.equal((await detail(environment.ownerDirectory)).memberships.length, 2);
    for (const role of ["member", "viewer", "admin"] as const) {
      await environment.service.setMembership(
        environment.owner.context,
        environment.account.id,
        environment.member.person.id,
        role,
        "active",
      );
      const account = await detail(environment.memberDirectory);
      assert.equal(account.membershipsVisible, role === "admin");
      assert.equal(account.memberships.length, role === "admin" ? 2 : 1);
      assert.equal(account.role, role);
    }
    const restarted = canonicalAccountsHandler(
      new VirtuusIdentityFiles(environment.root),
      new VirtuusAccountFiles(environment.root),
      environment.products,
      environment.identityFixture.keys,
      () => environment.identityFixture.now,
    );
    assert.equal(
      JSON.parse(
        (
          await restarted(
            environment.identityFixture.event(
              0,
              `/v1/account-directory/${environment.account.id}`,
              {},
              environment.memberDirectory.proof,
              "GET",
            ),
          )
        ).body,
      ).account.name,
      "Persisted Papyrus organization",
    );
    await environment.service.setMembership(
      environment.owner.context,
      environment.account.id,
      environment.member.person.id,
      "admin",
      "revoked",
    );
    assert.equal(
      (
        await restarted(
          environment.identityFixture.event(
            0,
            `/v1/account-directory/${environment.account.id}`,
            {},
            environment.memberDirectory.proof,
            "GET",
          ),
        )
      ).statusCode,
      403,
    );
    const list = JSON.parse(
      (
        await restarted(
          environment.identityFixture.event(
            0,
            "/v1/account-directory",
            {},
            environment.memberDirectory.proof,
            "GET",
          ),
        )
      ).body,
    );
    assert.deepEqual(list.accounts, []);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
test("JWT BFF returns actual persisted accounts and rejects browser authority or write paths", async () => {
  const environment = await directoryFixture();
  let forwarded = 0;
  try {
    const bff = accountsBffHandler({
      origin: "https://prospectus.anth.us",
      registration: environment.products[0],
      keys: environment.identityFixture.keys,
      nowSeconds: () => environment.identityFixture.now,
      client: (access, id) =>
        new AccountsClient(async (path, method, body) => {
          forwarded++;
          const event = environment.identityFixture.event(
            0,
            path,
            body ?? {},
            environment.ownerDirectory.proof,
            method,
          );
          event.headers!["x-prospectus-human-token"] = access;
          if (id) event.headers!["x-prospectus-identity-token"] = id;
          const response = await environment.handler()(event);
          return decode(new Response(response.body, { status: response.statusCode }));
        }),
    });
    const event = {
      rawPath: "/api/saas/accounts",
      requestContext: { http: { method: "GET" } },
      headers: { authorization: `Bearer ${environment.ownerDirectory.proof.access}` },
    };
    const list = await bff(event);
    assert.equal(list.statusCode, 200);
    assert.equal(JSON.parse(list.body).accounts[0].id, environment.account.id);
    const detail = await bff({ ...event, rawPath: `/api/saas/accounts/${environment.account.id}` });
    assert.equal(JSON.parse(detail.body).account.membershipsVisible, true);
    const before = forwarded;
    assert.equal((await bff({ ...event, headers: {} })).statusCode, 401);
    assert.equal(forwarded, before);
    assert.equal(
      (
        await bff({
          ...event,
          rawPath: "/api/saas/identity/challenge",
          requestContext: { http: { method: "POST" } },
          headers: { ...event.headers, origin: "https://wrong.invalid" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await bff({
          ...event,
          requestContext: { http: { method: "POST" } },
          headers: { ...event.headers, origin: "https://prospectus.anth.us" },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await bff({
          ...event,
          rawPath: "/api/saas/identity/challenge",
          requestContext: { http: { method: "POST" } },
          headers: {
            ...event.headers,
            origin: "https://prospectus.anth.us",
            "content-type": "application/json",
          },
          body: JSON.stringify({ roleArn: "forged" }),
        })
      ).statusCode,
      400,
    );
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
test("BFF fresh Google confirmation requires independent signed ID evidence and frozen challenge", async () => {
  const environment = await directoryFixture();
  try {
    const bff = accountsBffHandler({
      origin: "https://prospectus.anth.us",
      registration: environment.products[0],
      keys: environment.identityFixture.keys,
      nowSeconds: () => environment.identityFixture.now,
      client: (access, id) =>
        new AccountsClient(async (path, method, body) => {
          const event = environment.identityFixture.event(
            0,
            path,
            body ?? {},
            environment.ownerDirectory.proof,
            method,
          );
          event.headers!["x-prospectus-human-token"] = access;
          if (id) event.headers!["x-prospectus-identity-token"] = id;
          const response = await environment.handler()(event);
          return decode(new Response(response.body, { status: response.statusCode }));
        }),
    });
    const event = {
      rawPath: "/api/saas/identity/challenge",
      requestContext: { http: { method: "POST" } },
      headers: {
        authorization: `Bearer ${environment.ownerDirectory.proof.access}`,
        origin: "https://prospectus.anth.us",
        "content-type": "application/json",
      },
      body: "{}",
    };
    const challengeResponse = await bff(event);
    assert.equal(challengeResponse.statusCode, 200);
    const challenge = JSON.parse(challengeResponse.body);
    const fresh = environment.identityFixture.pair(
      0,
      challenge.nonce,
      "synthetic-google-owner",
      { sub: "synthetic-owner-0", origin_jti: "synthetic-new-family" },
      { sub: "synthetic-owner-0", origin_jti: "synthetic-new-family" },
    );
    const directoryRead = {
      rawPath: "/api/saas/accounts",
      requestContext: { http: { method: "GET" } },
      headers: { authorization: `Bearer ${fresh.access}` },
    };
    const beforeEnrollment = await bff(directoryRead);
    assert.equal(beforeEnrollment.statusCode, 200);
    assert.deepEqual(JSON.parse(beforeEnrollment.body), { person: null, accounts: [] });
    const resolve = {
      ...event,
      rawPath: "/api/saas/identity/resolve",
      headers: { ...event.headers, authorization: `Bearer ${fresh.access}` },
      body: JSON.stringify({ challengeId: challenge.challengeId, idToken: fresh.id }),
    };
    const confirmed = await bff(resolve);
    assert.equal(confirmed.statusCode, 200);
    assert.equal(JSON.parse(confirmed.body).person.id, environment.owner.person.id);
    const afterEnrollment = await bff(directoryRead);
    assert.equal(afterEnrollment.statusCode, 200);
    assert.equal(JSON.parse(afterEnrollment.body).accounts[0].id, environment.account.id);
    for (const unusableChallengeId of [[challenge.challengeId], 5, null]) {
      const refused = await bff({
        ...resolve,
        body: JSON.stringify({ challengeId: unusableChallengeId, idToken: fresh.id }),
      });
      assert.equal(refused.statusCode, 400);
      assert.equal(JSON.parse(refused.body).error, "body");
    }
    assert.equal(
      (
        await bff({
          ...resolve,
          body: JSON.stringify({ challengeId: challenge.challengeId, idToken: "forged" }),
        })
      ).statusCode,
      401,
    );
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("explicit central operator reads cross-organization records without membership or CRM-admin inheritance", async () => {
  const environment = await directoryFixture();
  try {
    const grants = [
      {
        product: environment.outsider.context.product,
        issuer: environment.outsider.context.human.issuer,
        subjectHash: operatorSubjectHash(environment.outsider.context.human.subject),
        permission: "accounts:admin:read" as const,
        reviewedGrantId: "synthetic-approval-v1",
      },
    ];
    const operator = canonicalAccountsHandler(
      new VirtuusIdentityFiles(environment.root),
      new VirtuusAccountFiles(environment.root),
      environment.products,
      environment.identityFixture.keys,
      () => environment.identityFixture.now,
      grants,
    );
    const event = (path: string, proof = environment.outsider.proof) =>
      environment.identityFixture.event(0, path, {}, proof, "GET");
    const listPath = "/v1/account-directory/operator/accounts",
      detailPath = `${listPath}/${environment.account.id}`;
    assert.equal(
      (await environment.handler()(event(listPath))).statusCode,
      403,
      "CRM admin alone never grants operator access",
    );
    assert.equal((await environment.handler()(event(detailPath))).statusCode, 403);
    const personal = JSON.parse((await operator(event("/v1/account-directory"))).body);
    assert.deepEqual(personal.accounts, []);
    assert.equal(personal.operatorAccess, true);
    assert.equal(
      (await operator(event(`/v1/account-directory/${environment.account.id}`))).statusCode,
      403,
      "operator does not become an account member",
    );
    const list = await operator(event(listPath));
    assert.equal(list.statusCode, 200);
    assert.equal(JSON.parse(list.body).accounts[0].id, environment.account.id);
    assert.equal(JSON.parse(list.body).accounts[0].activeMembers, 2);
    const detail = JSON.parse((await operator(event(detailPath))).body).account;
    assert.equal(detail.memberships.length, 2);
    assert.equal(detail.entitlements[0].product, "papyrus");
    assert.equal(detail.role, undefined);
    assert.equal(
      (
        await operator(
          environment.identityFixture.event(0, listPath, {}, environment.memberDirectory.proof, "GET"),
        )
      ).statusCode,
      403,
      "a different linked person cannot borrow the grant",
    );
    const newSession = environment.identityFixture.pair(
      0,
      "synthetic-unconfirmed",
      "synthetic-google-outsider",
      { sub: environment.outsider.context.human.subject, origin_jti: "new-unconfirmed-family" },
      { sub: environment.outsider.context.human.subject, origin_jti: "new-unconfirmed-family" },
    );
    assert.equal(
      (await operator(event(listPath, newSession))).statusCode,
      403,
      "operator still needs current canonical proof",
    );
    assert.equal(
      (await operator({ ...event(detailPath), httpMethod: "POST" })).statusCode,
      400,
      "operator surface is read-only",
    );
    const revoked = canonicalAccountsHandler(
      new VirtuusIdentityFiles(environment.root),
      new VirtuusAccountFiles(environment.root),
      environment.products,
      environment.identityFixture.keys,
      () => environment.identityFixture.now,
      [],
    );
    assert.equal(
      (await revoked(event(listPath))).statusCode,
      403,
      "removing the grant takes effect without changing memberships",
    );
    assert.equal((await operator(event(`${listPath}/00000000-0000-4000-8000-000000000000`))).statusCode, 404);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
