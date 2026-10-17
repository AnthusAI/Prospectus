import { createHash, randomUUID } from "node:crypto";
import {
  AccountsError,
  fail,
  roleOperations,
  UUID_PATTERN,
  type Account,
  type AccountSummary,
  type Context,
  type Entitlement,
  type ExternalIdentity,
  type Human,
  type Membership,
  type Operation,
  type Person,
  type Role,
} from "./model";
import type { PersonDirectory } from "./person-directory";
import { Conflict, type Entry, type Key, type TransactionStore, type Write } from "./store";
const key = (pk: string, sk = "META"): Key => ({ pk, sk });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identityKey = (human: Human) => key(`IDENTITY#${hash([human.issuer, human.subject])}`);
const personKey = (id: string) => key(`PERSON#${id}`);
const accountKey = (id: string) => key(`ACCOUNT#${id}`);
const membershipKey = (accountId: string, personId: string) =>
  key(`ACCOUNT#${accountId}`, `MEMBER#${personId}`);
const entitlementKey = (accountId: string, product: string) =>
  key(`ACCOUNT#${accountId}`, `PRODUCT#${product}`);
const changed = (entry: Entry, value: unknown): Write => ({
  pk: entry.pk,
  sk: entry.sk,
  version: entry.version,
  value,
});
const inserted = (key: Key, value: unknown): Write => ({ ...key, version: null, value });
/** Transactional memory-fixture compatibility service. Hosted composition uses DurableAccountsService. */
export class AccountsService {
  constructor(
    private store: TransactionStore,
    private now: () => string = () => new Date().toISOString(),
    private directory?: PersonDirectory,
  ) {}
  private validate(context: Context) {
    if (!context.product || !context.principal || !context.human.issuer || !context.human.subject)
      fail(401, "unverified", "Verified caller and human required.");
  }
  private async identity(context: Context): Promise<ExternalIdentity | null> {
    this.validate(context);
    const legacy = (await this.store.get<ExternalIdentity>(identityKey(context.human)))?.value ?? null;
    if (!this.directory) return legacy;
    const person = await this.directory.resolve(context);
    if (!person) return null;
    if (legacy && legacy.personId !== person.id)
      fail(
        409,
        "person_conflict",
        "Existing account identity differs from canonical Person; reconciliation required.",
      );
    return {
      issuer: context.human.issuer,
      subject: context.human.subject,
      personId: person.id,
      createdAt: person.createdAt,
    };
  }
  private async knownPerson(id: string): Promise<Person | null> {
    return this.directory
      ? this.directory.get(id)
      : ((await this.store.get<Person>(personKey(id)))?.value ?? null);
  }
  private async anchor(person: Person) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const existing = await this.store.get<Person>(personKey(person.id));
      if (existing) {
        if (existing.value.id !== person.id || existing.value.createdAt !== person.createdAt)
          fail(409, "person_conflict", "Account Person copy conflicts with canonical identity.");
        return;
      }
      try {
        await this.store.transact([inserted(personKey(person.id), person)]);
        return;
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    fail(409, "busy", "Person coordination copy changed concurrently.");
  }
  async resolve(context: Context): Promise<Person> {
    this.validate(context);
    if (this.directory) {
      const identity = await this.identity(context);
      if (!identity) fail(403, "identity_enrollment_required", "Committed identity enrollment required.");
      const person = await this.directory.get(identity.personId);
      if (!person) fail(403, "identity_enrollment_required", "Canonical Person is not committed.");
      return person;
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      const existing = await this.identity(context);
      if (existing) {
        const person = await this.store.get<Person>(personKey(existing.personId));
        if (!person) throw new Error("Identity authority is inconsistent.");
        return person.value;
      }
      const person: Person = { id: randomUUID(), createdAt: this.now() };
      const identity: ExternalIdentity = {
        issuer: context.human.issuer,
        subject: context.human.subject,
        personId: person.id,
        createdAt: person.createdAt,
      };
      try {
        await this.store.transact([
          inserted(personKey(person.id), person),
          inserted(identityKey(context.human), identity),
          inserted(key(`PERSON#${person.id}`, "AUDIT#resolved"), {
            type: "person.resolved",
            product: context.product,
            principal: context.principal,
            at: person.createdAt,
          }),
        ]);
        return person;
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    fail(409, "busy", "Identity changed concurrently; retry.");
  }
  async link(context: Context, proof: Human): Promise<Person> {
    if (this.directory)
      fail(
        409,
        "explicit_link_required",
        "Canonical identity linking requires a separately verified reconciliation flow.",
      );
    const person = await this.resolve(context);
    const target = await this.store.get<ExternalIdentity>(identityKey(proof));
    if (target) {
      if (target.value.personId !== person.id)
        fail(409, "identity_claimed", "Identity already belongs to another person; no automatic merge.");
      return person;
    }
    try {
      await this.store.transact([
        inserted(identityKey(proof), {
          issuer: proof.issuer,
          subject: proof.subject,
          personId: person.id,
          createdAt: this.now(),
        }),
        inserted(key(`PERSON#${person.id}`, `AUDIT#link#${hash([proof.issuer, proof.subject])}`), {
          type: "identity.linked",
          personId: person.id,
          product: context.product,
          principal: context.principal,
          at: this.now(),
        }),
      ]);
    } catch (error) {
      if (error instanceof Conflict) return this.link(context, proof);
      throw error;
    }
    return person;
  }
  async list(context: Context): Promise<{ person: Person | null; accounts: AccountSummary[] }> {
    const identity = await this.identity(context);
    if (!identity) return { person: null, accounts: [] };
    const person = await this.knownPerson(identity.personId);
    if (!person) throw new Error("Missing canonical person.");
    const memberships = await this.store.query<Membership>(`PERSON#${person.id}`, "ACCOUNT#");
    const accounts: AccountSummary[] = [];
    for (const row of memberships) {
      try {
        accounts.push((await this.allowed(context, row.value.accountId, "console:read")).summary);
      } catch (error) {
        if (!(error instanceof AccountsError && error.status === 403)) throw error;
      }
    }
    return { person, accounts };
  }
  async create(context: Context, name: string, requestId: string): Promise<AccountSummary> {
    this.validate(context);
    if (!UUID_PATTERN.test(requestId) || typeof name !== "string" || !name.trim() || name.trim().length > 150)
      fail(400, "invalid", "A UUID idempotency key and account name are required.");
    if (!context.capabilities.includes("console:read"))
      fail(403, "product_forbidden", "Product cannot provision console accounts.");
    const person = await this.resolve(context);
    if (this.directory) await this.anchor(person);
    name = name.trim();
    const receiptKey = key(`PERSON#${person.id}`, `CREATE#${hash([context.product, requestId])}`);
    const fingerprint = hash({ name, product: context.product });
    for (let attempt = 0; attempt < 12; attempt++) {
      const receipt = await this.store.get<{ fingerprint: string; accountId: string }>(receiptKey);
      if (receipt) {
        if (receipt.value.fingerprint !== fingerprint)
          fail(409, "idempotency_conflict", "This request key belongs to different account input.");
        return (await this.allowed(context, receipt.value.accountId, "console:read")).summary;
      }
      const personEntry = await this.store.get(personKey(person.id));
      if (!personEntry) throw new Error("Missing person.");
      const rows = await this.store.query<Membership>(`PERSON#${person.id}`, "ACCOUNT#");
      if (rows.length >= 100) fail(409, "membership_limit", "Account membership limit reached.");
      const account: Account = {
        id: randomUUID(),
        name,
        createdAt: this.now(),
        revision: 1,
        owners: 1,
        members: 1,
      };
      const member: Membership = {
        accountId: account.id,
        personId: person.id,
        role: "owner",
        status: "active",
      };
      const entitlement: Entitlement = {
        accountId: account.id,
        product: context.product,
        status: "active",
        capabilities: [...context.capabilities],
      };
      try {
        await this.store.transact([
          inserted(accountKey(account.id), account),
          inserted(membershipKey(account.id, person.id), member),
          inserted(key(`PERSON#${person.id}`, `ACCOUNT#${account.id}`), member),
          inserted(entitlementKey(account.id, context.product), entitlement),
          inserted(receiptKey, { fingerprint, accountId: account.id }),
          changed(personEntry, personEntry.value),
          inserted(key(`ACCOUNT#${account.id}`, `AUDIT#${account.revision}`), {
            type: "account.created",
            personId: person.id,
            product: context.product,
            principal: context.principal,
            at: this.now(),
          }),
        ]);
        return { id: account.id, name, role: "owner", entitlement };
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    fail(409, "busy", "Account changed concurrently; retry with the same request key.");
  }
  private async allowed(context: Context, accountId: string, operation: Operation) {
    const identity = await this.identity(context);
    if (!identity || !context.capabilities.includes(operation))
      fail(403, "forbidden", "Account operation is not permitted.");
    const member = await this.store.get<Membership>(membershipKey(accountId, identity.personId));
    const entitlement = await this.store.get<Entitlement>(entitlementKey(accountId, context.product));
    if (
      !member ||
      member.value.status !== "active" ||
      !roleOperations[member.value.role]?.includes(operation) ||
      !entitlement ||
      entitlement.value.status !== "active" ||
      !entitlement.value.capabilities.includes(operation)
    )
      fail(403, "forbidden", "Account operation is not permitted.");
    const account = await this.store.get<Account>(accountKey(accountId));
    if (!account) fail(403, "forbidden", "Account operation is not permitted.");
    return {
      personId: identity.personId,
      member,
      entitlement,
      account,
      summary: {
        id: account.value.id,
        name: account.value.name,
        role: member.value.role,
        entitlement: entitlement.value,
      } satisfies AccountSummary,
    };
  }
  async get(context: Context, accountId: string) {
    return (await this.allowed(context, accountId, "console:read")).summary;
  }
  async authorize(context: Context, accountId: string, operation: Operation) {
    if (!roleOperations.owner.includes(operation))
      fail(400, "invalid_operation", "Unknown account operation.");
    const state = await this.allowed(context, accountId, operation);
    return {
      allowed: true as const,
      accountId,
      personId: state.personId,
      product: context.product,
      role: state.member.value.role,
      operation,
      revision: state.account.value.revision,
    };
  }
  async setMembership(
    context: Context,
    accountId: string,
    personId: string,
    role: Role,
    status: Membership["status"],
  ) {
    if (!Object.hasOwn(roleOperations, role) || !["active", "revoked"].includes(status))
      fail(400, "invalid_membership", "Invalid membership.");
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await this.allowed(context, accountId, "members:write");
      if (this.directory) {
        const canonical = await this.directory.get(personId);
        if (!canonical) fail(404, "unknown_person", "A committed canonical Person is required.");
        await this.anchor(canonical);
      }
      const targetPerson = await this.store.get<Person>(personKey(personId));
      if (!targetPerson)
        fail(404, "unknown_person", "A known person is required; this does not send invitations.");
      const prior = await this.store.get<Membership>(membershipKey(accountId, personId));
      if (state.member.value.role !== "owner" && (role === "owner" || prior?.value.role === "owner"))
        fail(403, "owner_required", "Only an owner can change ownership.");
      const wasOwner = prior?.value.status === "active" && prior.value.role === "owner" ? 1 : 0;
      const becomesOwner = status === "active" && role === "owner" ? 1 : 0;
      const owners = state.account.value.owners - wasOwner + becomesOwner;
      if (owners < 1) fail(409, "last_owner", "The account must retain an active owner.");
      const wasActive = prior?.value.status === "active" ? 1 : 0;
      const becomesActive = status === "active" ? 1 : 0;
      const members = state.account.value.members - wasActive + becomesActive;
      if (members > 100) fail(409, "membership_limit", "Account membership limit reached.");
      if (
        !wasActive &&
        becomesActive &&
        (await this.store.query<Membership>(`PERSON#${personId}`, "ACCOUNT#")).length >= 100
      )
        fail(409, "membership_limit", "Person membership limit reached.");
      const reciprocal = await this.store.get<Membership>(key(`PERSON#${personId}`, `ACCOUNT#${accountId}`));
      const membership: Membership = { accountId, personId, role, status };
      const revision = state.account.value.revision + 1;
      const writes = [
        changed(state.account, { ...state.account.value, owners, members, revision }),
        { ...membershipKey(accountId, personId), version: prior?.version ?? null, value: membership },
        {
          ...key(`PERSON#${personId}`, `ACCOUNT#${accountId}`),
          version: reciprocal?.version ?? null,
          value: membership,
        },
        changed(targetPerson, targetPerson.value),
        inserted(key(`ACCOUNT#${accountId}`, `AUDIT#${revision}`), {
          type: "membership.changed",
          actor: state.personId,
          target: personId,
          role,
          status,
          product: context.product,
          principal: context.principal,
          at: this.now(),
        }),
      ];
      const checks = [state.entitlement, ...(personId === state.personId ? [] : [state.member])].map(
        (row) => ({ pk: row.pk, sk: row.sk, version: row.version }),
      );
      try {
        await this.store.transact(writes, checks);
        return membership;
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    fail(409, "busy", "Concurrent membership change; retry.");
  }
}
