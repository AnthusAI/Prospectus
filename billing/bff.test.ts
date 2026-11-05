import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsBffHandler, type BffEvent } from "../accounts/bff";
import { canonicalAccountsHandler } from "../accounts/canonical-handler";
import { VirtuusAccountFiles, VirtuusBillingFiles, VirtuusIdentityFiles } from "../accounts/identity-files";
import { operatorGrants, operatorSubjectHash, type OperatorPermission } from "../accounts/operator-policy";
import { directoryFixture } from "../accounts/testing/directory-fixture";
import { AccountsClient, decode } from "../packages/accounts-client/src/client";
import { billingBrowser } from "../src/billing/client";
import { BillingError } from "../src/billing/types";
import { BILLING_MAXIMUM_BODY_BYTES, MAXIMUM_PDF_BYTES, centralBillingPath, isBillingPath } from "./paths";
import { CONTACT_MARKER, contact } from "./testing/billing-fixture";
import { billingOperatorRoutes } from "./routes";
import { billingFixture, grants, issuerFields, lineItems, operator } from "./testing/billing-fixture";
import { reviewedBillingPlans } from "./plans";

const ORIGIN = "https://prospectus.anth.us";
const BFF = "https://bff.example.invalid/api/saas";

/** The browser client, the staff BFF and the central handler over real Virtuus files, wired end to end. */
async function chain(permissions: OperatorPermission[] = ["accounts:admin:read", "accounts:admin:billing"]) {
  const environment = await directoryFixture();
  const central = canonicalAccountsHandler(
    new VirtuusIdentityFiles(environment.root),
    new VirtuusAccountFiles(environment.root),
    environment.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
    operatorGrants(
      permissions.map((permission) => ({
        product: environment.outsider.context.product,
        issuer: environment.outsider.context.human.issuer,
        subjectHash: operatorSubjectHash(environment.outsider.context.human.subject),
        permission,
        reviewedGrantId: `synthetic-${permission.split(":").pop()}-v1`,
      })),
    ),
    "scan",
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    new VirtuusBillingFiles(environment.root),
  );
  const forwarded: string[] = [];
  const bff = accountsBffHandler({
    surface: "staff",
    origins: [ORIGIN],
    registration: environment.products[0],
    keys: environment.identityFixture.keys,
    nowSeconds: () => environment.identityFixture.now,
    client: (access) =>
      new AccountsClient(async (path, method, body) => {
        forwarded.push(`${method} ${path}`);
        const event = environment.identityFixture.event(
          0,
          path,
          body ?? {},
          environment.outsider.proof,
          method,
        );
        event.headers!["x-prospectus-human-token"] = access;
        if (method === "GET") event.body = null;
        const response = await central(event);
        return decode(new Response(response.body, { status: response.statusCode }));
      }),
  });
  /** Sends a request to the BFF the way API Gateway would, and returns it as a fetch Response. */
  const raw: Array<{ event: BffEvent; response: any }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const event: BffEvent = {
      rawPath: url.pathname,
      requestContext: { http: { method: init?.method ?? "GET" } },
      headers: { ...headers, ...(init?.method === "POST" ? { origin: ORIGIN } : {}) },
      body: (init?.body as string | undefined) ?? null,
    };
    const response: any = await bff(event);
    raw.push({ event, response });
    const body = response.isBase64Encoded ? Buffer.from(response.body, "base64") : response.body;
    return new Response(body, { status: response.statusCode, headers: response.headers });
  }) as typeof fetch;
  const client = billingBrowser(BFF, fetcher, () => environment.outsider.proof.access);
  return { environment, client, bff, fetcher, forwarded, raw, accountId: environment.account.id };
}

test("every route the console client calls is forwarded by the BFF and served by central, end to end", async () => {
  const logged: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => {
    const original = console[level];
    console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    return () => (console[level] = original);
  });
  try {
    const { client, accountId, forwarded, raw, environment } = await chain();
    const paymentMethods = [
      { label: "Melio", instructions: "Pay at https://pay.example.com/placeholder-link", offered: true },
    ];

    const access = await client.access();
    assert.deepEqual(access.permissions.sort(), ["accounts:admin:billing", "accounts:admin:read"]);
    const settings = await client.saveIssuer({
      operationId: randomUUID(),
      issuer: issuerFields().issuer,
      paymentMethods,
      defaultNetTermsDays: 30,
      expectedRevision: 0,
    });
    assert.equal(settings.revision, 1);
    assert.equal((await client.issuer()).issuer.legalName, "Example Issuer LLC");

    // A profile needs a contact, which the console does not send; seed one through central, then save through the client.
    const seed = environment.identityFixture.event(
      0,
      `/v1/account-directory/operator/accounts/${accountId}/billing-profile`,
      { operationId: randomUUID(), mode: "invoiced", billingContact: contact() },
      environment.outsider.proof,
      "POST",
    );
    const seeded = await fetchCentral(environment, seed);
    assert.equal(seeded.statusCode, 200, seeded.body);
    const saved = await client.saveProfile(accountId, {
      operationId: randomUUID(),
      mode: "invoiced",
      netTermsDays: 30,
      expectedRevision: 1,
    });
    assert.equal(saved.mode, "invoiced");
    assert.ok(!JSON.stringify(saved).includes(CONTACT_MARKER));

    const overview0 = await client.overview();
    assert.equal(
      overview0.accounts.some((entry) => entry.id === accountId && entry.billable),
      true,
    );

    const invoice = await client.raiseInvoice({
      operationId: randomUUID(),
      accountId,
      period: "2026-11",
      lineItems: [{ description: "Example site, November", quantity: 1, unitAmountCents: 120000 }],
      netTermsDays: 30,
      issuedVia: "manual",
      draft: false,
    });
    assert.equal(invoice.status, "issued");
    assert.match(invoice.number!, /^\d{6}-001$/);
    const detail = await client.invoice(invoice.number!);
    assert.equal(detail.invoice.id, invoice.id);

    // The PDF is carried through as binary.
    const pdf = await client.invoicePdf(invoice.number!);
    assert.equal(pdf.type, "application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    assert.ok(bytes.length > 500 && bytes.length < MAXIMUM_PDF_BYTES);
    const pdfExchange = raw.at(-1)!;
    assert.equal(pdfExchange.response.isBase64Encoded, true);
    assert.equal(pdfExchange.response.headers["Content-Type"], "application/pdf");
    assert.match(
      pdfExchange.response.headers["Content-Disposition"],
      /^attachment; filename="invoice-\d{6}-001\.pdf"$/,
    );
    assert.equal(pdfExchange.response.headers["Cache-Control"], "no-store");

    const payment = await client.recordPayment({
      operationId: randomUUID(),
      accountId,
      amountCents: 100000,
      method: "melio",
      receivedAt: "2026-11-03",
      reference: "EX-1",
      allocations: [{ invoiceId: invoice.id, amountCents: 60000 }],
    });
    assert.equal(payment.unallocatedCents, 40000);
    const allocated = await client.allocate(payment.id, {
      operationId: randomUUID(),
      allocations: [{ invoiceId: invoice.id, amountCents: 40000 }],
      expectedRevision: payment.revision,
    });
    assert.equal(allocated.unallocatedCents, 0);
    assert.equal((await client.payment(payment.id)).payment.id, payment.id);
    const reversed = await client.reversePayment(payment.id, {
      operationId: randomUUID(),
      reason: "Payment failed",
      expectedRevision: allocated.revision,
    });
    assert.equal(reversed.reversal?.reason, "Payment failed");
    const written = await client
      .writeOff(invoice.id, { operationId: randomUUID(), reason: "Client closed", expectedRevision: 99 })
      .catch((error) => error);
    assert.ok(
      written instanceof BillingError && written.status === 409 && written.code === "revision_conflict",
      String(written),
    );
    const detailNow = await client.invoice(invoice.number!);
    assert.equal(
      (
        await client.writeOff(invoice.id, {
          operationId: randomUUID(),
          reason: "Client closed",
          expectedRevision: detailNow.invoice.revision,
        })
      ).status,
      "uncollectible",
    );
    const second = await client.raiseInvoice({
      operationId: randomUUID(),
      accountId,
      lineItems: [{ description: "One-off", quantity: 1, unitAmountCents: 5000 }],
      netTermsDays: 30,
      issuedVia: "manual",
      draft: true,
    });
    assert.equal(second.status, "draft");
    assert.equal(
      (
        await client.voidInvoice(second.id, {
          operationId: randomUUID(),
          reason: "Raised in error",
          expectedRevision: second.revision,
        })
      ).status,
      "void",
    );

    const view = await client.account(accountId);
    assert.equal(view.invoices.length, 2);
    assert.equal(view.payments.length, 1);
    assert.ok(view.journal.length >= 8);
    assert.equal(view.lines.length, 0);
    assert.equal((await client.revealContact(accountId)).name, contact().name);
    assert.equal((await client.overview()).invoices.length, 2);

    // Every request the client made was forwarded by the BFF to a central billing path, and none was refused as unknown.
    assert.ok(forwarded.length >= 25);
    for (const entry of forwarded) assert.ok(isBillingPath(entry.split(" ")[1]), entry);
    for (const { response } of raw)
      assert.ok(![404, 405].includes(response.statusCode), JSON.stringify(response).slice(0, 200));
  } finally {
    for (const restore of spies) restore();
  }
  // Nothing logged carries the billing contact or any PDF bytes.
  for (const line of logged) {
    assert.ok(!line.includes(CONTACT_MARKER), "a log line carried billing contact data");
    assert.ok(!line.includes("%PDF"), "a log line carried PDF bytes");
    assert.ok(!/JVBERi0/.test(line), "a log line carried base64 PDF bytes");
  }
});

async function fetchCentral(environment: Awaited<ReturnType<typeof directoryFixture>>, event: any) {
  const central = canonicalAccountsHandler(
    new VirtuusIdentityFiles(environment.root),
    new VirtuusAccountFiles(environment.root),
    environment.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
    operatorGrants([
      {
        product: environment.outsider.context.product,
        issuer: environment.outsider.context.human.issuer,
        subjectHash: operatorSubjectHash(environment.outsider.context.human.subject),
        permission: "accounts:admin:billing",
        reviewedGrantId: "synthetic-billing-v1",
      },
    ]),
    "scan",
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    new VirtuusBillingFiles(environment.root),
  );
  return central(event);
}

test("the BFF keeps its origin, authentication and refusal behavior for billing routes", async () => {
  const { bff, environment, accountId } = await chain(["accounts:admin:read"]);
  const send = (
    method: string,
    rawPath: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<any> =>
    bff({
      rawPath,
      requestContext: { http: { method } },
      headers: {
        authorization: `Bearer ${environment.outsider.proof.access}`,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  // A write from another origin is refused before it is forwarded.
  const wrongOrigin = await send(
    "POST",
    `/api/saas/operator/accounts/${accountId}/payments`,
    { operationId: randomUUID() },
    { origin: "https://evil.example" },
  );
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal(JSON.parse(wrongOrigin.body).error, "origin");
  // No token, no forward.
  const anonymous = await bff({
    rawPath: "/api/saas/operator/billing/invoices",
    requestContext: { http: { method: "GET" } },
    headers: {},
  });
  assert.equal(anonymous.statusCode, 401);
  // Only GET and POST.
  assert.equal(
    (await send("PUT", "/api/saas/operator/billing/issuer", {}, { origin: ORIGIN })).statusCode,
    405,
  );
  // A path the BFF does not forward is the usual 404.
  for (const rawPath of [
    "/api/saas/operator/billing-lines",
    "/api/saas/operator/accounts/not-an-id/invoices",
    "/api/saas/operator/billing/../accounts",
    "/api/saas/operator/accounts/x",
  ])
    assert.equal((await send("GET", rawPath)).statusCode, 404, rawPath);
  // A read-only operator reads, and central's refusal of a write is passed on with its code and message.
  assert.equal((await send("GET", "/api/saas/operator/billing/invoices")).statusCode, 200);
  const refused = await send(
    "POST",
    `/api/saas/operator/accounts/${accountId}/payments`,
    { operationId: randomUUID(), amountCents: 1, method: "cash", receivedAt: "2026-11-03" },
    { origin: ORIGIN },
  );
  assert.equal(refused.statusCode, 403);
  assert.equal(JSON.parse(refused.body).code, "forbidden");
  assert.match(JSON.parse(refused.body).message, /accounts:admin:billing/);
  // A GET carries no body.
  assert.equal((await send("GET", "/api/saas/operator/billing/invoices", { x: 1 })).statusCode, 400);
});

test("the BFF accepts an invoice-sized body and refuses a larger one", async () => {
  const { bff, environment, accountId } = await chain();
  const post = (body: string) =>
    bff({
      rawPath: `/api/saas/operator/accounts/${accountId}/invoices`,
      requestContext: { http: { method: "POST" } },
      headers: {
        authorization: `Bearer ${environment.outsider.proof.access}`,
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body,
    }) as Promise<any>;
  const big = JSON.stringify({ operationId: randomUUID(), pad: "x".repeat(BILLING_MAXIMUM_BODY_BYTES) });
  assert.equal((await post(big)).statusCode, 400);
  // Other BFF routes keep their smaller limit.
  const small = await bff({
    rawPath: "/api/saas/accounts",
    requestContext: { http: { method: "POST" } },
    headers: {
      authorization: `Bearer ${environment.outsider.proof.access}`,
      "content-type": "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify({ name: "x".repeat(25000), requestKey: randomUUID() }),
  });
  assert.equal(small.statusCode, 400);
});

test("a PDF that is not a PDF, or too large for a Lambda response, is not carried through", async () => {
  const environment = await directoryFixture();
  const serve = (value: unknown) =>
    accountsBffHandler({
      surface: "staff",
      origins: [ORIGIN],
      registration: environment.products[0],
      keys: environment.identityFixture.keys,
      nowSeconds: () => environment.identityFixture.now,
      client: () => new AccountsClient(async () => value),
    })({
      rawPath: "/api/saas/operator/billing/invoices/202611-001/pdf",
      requestContext: { http: { method: "GET" } },
      headers: { authorization: `Bearer ${environment.outsider.proof.access}` },
    }) as Promise<any>;
  const pdf = Buffer.from("%PDF-1.7 placeholder").toString("base64");
  const ok = await serve({ filename: "invoice-202611-001.pdf", contentType: "application/pdf", base64: pdf });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.isBase64Encoded, true);
  for (const bad of [
    { filename: "invoice-202611-001.pdf", contentType: "text/html", base64: pdf },
    { filename: "../etc/passwd", contentType: "application/pdf", base64: pdf },
    {
      filename: "invoice-202611-001.pdf",
      contentType: "application/pdf",
      base64: Buffer.from("<html>").toString("base64"),
    },
    {
      filename: "invoice-202611-001.pdf",
      contentType: "application/pdf",
      base64: "A".repeat(Math.ceil((MAXIMUM_PDF_BYTES * 4) / 3) + 100),
    },
    { filename: "invoice-202611-001.pdf", contentType: "application/pdf" },
  ]) {
    const refused = await serve(bad);
    assert.equal(refused.statusCode, 502);
    assert.equal(JSON.parse(refused.body).error, "pdf_unavailable");
  }
});

test("central refuses a PDF larger than the Lambda response limit with 413, never a gateway error", async () => {
  const fixture = billingFixture();
  const ada = operator("ada");
  await fixture.profiles.set(
    ada,
    fixture.accountId,
    { mode: "invoiced", currency: "usd", billingContact: contact() },
    randomUUID(),
  );
  await fixture.issuer.set(ada, issuerFields(), randomUUID());
  const { invoice } = await fixture.ledger.raise(
    ada,
    fixture.accountId,
    { lineItems: lineItems(), draft: false, issueDate: "2026-11-02" },
    randomUUID(),
  );
  const routes = (maximumPdfBytes?: number) =>
    billingOperatorRoutes({
      ledger: fixture.ledger,
      profiles: fixture.profiles,
      lines: fixture.lines,
      issuer: fixture.issuer,
      plans: reviewedBillingPlans(),
      grants,
      accounts: { all: async () => [], get: async (id) => ({ id, name: "Example" }) },
      files: fixture.store,
      now: () => "2026-11-05T00:00:00.000Z",
      ...(maximumPdfBytes ? { maximumPdfBytes } : {}),
    });
  const event = {
    httpMethod: "GET",
    path: `/v1/account-directory/operator/billing/invoices/${invoice.number}/pdf`,
    headers: { accept: "application/pdf" },
  };
  assert.equal(((await routes()(event, ada)) as any).statusCode, 200);
  await assert.rejects(
    routes(100)(event, ada),
    (error: any) => error.status === 413 && error.code === "pdf_too_large",
  );
});

test("the console client's paths are exactly the paths the BFF forwards", async () => {
  const seen: Array<[string, string]> = [];
  const client = billingBrowser(
    BFF,
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([init?.method ?? "GET", new URL(String(input)).pathname]);
      return new Response(
        JSON.stringify({ accounts: [], invoices: [], payments: [], events: [], lines: [], permissions: [] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch,
    () => "token",
  );
  const id = randomUUID(),
    op = randomUUID();
  const calls: Array<() => Promise<unknown>> = [
    () => client.access(),
    () => client.overview(),
    () => client.account(id),
    () => client.invoice("202611-001"),
    () => client.invoice(id),
    () => client.invoicePdf("202611-001"),
    () => client.payment(id),
    () => client.revealContact(id),
    () => client.saveProfile(id, { operationId: op, mode: "invoiced" }),
    () =>
      client.raiseInvoice({
        operationId: op,
        accountId: id,
        lineItems: [],
        netTermsDays: 30,
        issuedVia: "manual",
        draft: true,
      }),
    () =>
      client.recordPayment({
        operationId: op,
        accountId: id,
        amountCents: 1,
        method: "cash",
        receivedAt: "2026-11-03",
        allocations: [],
      }),
    () => client.allocate(id, { operationId: op, allocations: [], expectedRevision: 1 }),
    () => client.reversePayment(id, { operationId: op, reason: "x", expectedRevision: 1 }),
    () => client.writeOff(id, { operationId: op, reason: "x", expectedRevision: 1 }),
    () => client.voidInvoice(id, { operationId: op, reason: "x", expectedRevision: 1 }),
    () => client.issuer(),
    () =>
      client.saveIssuer({
        operationId: op,
        issuer: issuerFields().issuer,
        paymentMethods: [],
        defaultNetTermsDays: 30,
        expectedRevision: 0,
      }),
  ];
  for (const call of calls) await call().catch(() => undefined);
  assert.ok(seen.length >= 20);
  for (const [method, path] of seen) {
    assert.ok(["GET", "POST"].includes(method), `${method} ${path}: the BFF routes only GET and POST`);
    const central = centralBillingPath(path.replace(/^\/api\/saas/, "/api/saas"));
    assert.ok(central, `${method} ${path} is not forwarded by the BFF`);
    assert.ok(isBillingPath(central!));
  }
});
