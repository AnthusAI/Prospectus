import { createHash } from "node:crypto";
import {
  AccountsError,
  fail,
  roleOperations,
  UUID_PATTERN,
  type AccountAuthorization,
  type AccountSummary,
  type Context,
  type Entitlement,
  type Membership,
  type Operation,
  type Person,
  type Role,
} from "./model";
import { IdentityFileError, type IdentityFiles, type IdentityObject } from "./identity-files";
import type { PersonDirectory } from "./person-directory";
import type { AccountsApi } from "./handler";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const path = (id: string) => `accounts/${id}.json`;
const membershipMarkerPath = (personId: string, accountId: string) => `members/${personId}/${accountId}.json`;
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
export function createdAccountId(personId: string, product: string, requestId: string) {
  const hex = hash(["prospectus-account-create-v1", personId, product, requestId.toLowerCase()]).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
export type MembershipLookup = "scan" | "indexed";
export function membershipLookupMode(value: unknown): MembershipLookup {
  if (value === undefined) return "scan";
  if (value !== "scan" && value !== "indexed") throw new Error("Membership lookup must be scan or indexed.");
  return value;
}
export interface AccountDocument {
  version: 1;
  kind: "account";
  account: { id: string; name: string; createdAt: string; revision: number };
  creation: { personId: string; product: string; requestHash: string; fingerprint: string };
  memberships: Record<string, Membership>;
  entitlements: Record<string, Entitlement>;
  audit: Array<{
    type: "account.created" | "membership.changed" | "entitlement.changed";
    revision: number;
    actor: string;
    product: string;
    principal: string;
    at: string;
    target?: string;
    role?: Role;
    status?: Membership["status"] | Entitlement["status"];
  }>;
}
/** A single canonical aggregate owns each account's permissions. No reciprocal
 * membership authority, distributed transaction emulation, DDB or process lock.
 * Membership markers under members/<person>/ only narrow discovery: they are
 * written before the account publishes, never removed, and every candidate is
 * rechecked against its canonical account document.
 */
export class DurableAccountsService implements AccountsApi {
  constructor(
    private files: IdentityFiles,
    private directory: PersonDirectory,
    private now: () => string = () => new Date().toISOString(),
    private membershipLookup: MembershipLookup = "scan",
  ) {}
  private async publish<T>(
    location: string,
    operationId: string,
    requestHash: string,
    value: T,
    revision: string | null,
  ) {
    // Reconcile the exact frozen Virtuus intent only. Never steal/reset a claim or
    // manufacture a replacement operation while publication may be in flight.
    for (let attempt = 0; ; attempt++)
      try {
        return await this.files.commit(location, operationId, requestHash, value, revision);
      } catch (error) {
        if (
          !(error instanceof IdentityFileError && ["uncertain", "unavailable"].includes(error.code)) ||
          attempt >= 3
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
  }
  private personResolutionsByRequestContext = new WeakMap<Context, Promise<Person>>();
  person(context: Context): Promise<Person> {
    let resolution = this.personResolutionsByRequestContext.get(context);
    if (!resolution) {
      resolution = this.resolvePerson(context);
      this.personResolutionsByRequestContext.set(context, resolution);
    }
    return resolution;
  }
  private async resolvePerson(context: Context): Promise<Person> {
    if (!context.product || !context.principal || !context.human?.issuer || !context.human.subject)
      fail(401, "unverified", "Verified caller and human required.");
    const person = await this.directory.resolve(context);
    if (!person) fail(403, "identity_enrollment_required", "Committed canonical Person required.");
    return person;
  }
  private validate(value: AccountDocument, id: string) {
    const bad = () => fail(503, "account_inconsistent", "Canonical account document is inconsistent.");
    if (
      !record(value) ||
      value.version !== 1 ||
      value.kind !== "account" ||
      !record(value.account) ||
      value.account.id !== id ||
      !UUID_PATTERN.test(id) ||
      typeof value.account.name !== "string" ||
      !value.account.name.trim() ||
      value.account.name.length > 150 ||
      !timestamp(value.account.createdAt) ||
      !Number.isSafeInteger(value.account.revision) ||
      value.account.revision < 1 ||
      !record(value.creation) ||
      !UUID_PATTERN.test(value.creation.personId) ||
      typeof value.creation.product !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.creation.requestHash) ||
      !/^[a-f0-9]{64}$/.test(value.creation.fingerprint) ||
      !record(value.memberships) ||
      !record(value.entitlements) ||
      !Array.isArray(value.audit) ||
      value.audit.length < 1 ||
      value.audit.length > 128 ||
      Object.keys(value.memberships).length > 100 ||
      Buffer.byteLength(JSON.stringify(value)) > 65536
    )
      bad();
    let owners = 0;
    for (const [personId, member] of Object.entries(value.memberships)) {
      if (
        !UUID_PATTERN.test(personId) ||
        !record(member) ||
        member.personId !== personId ||
        member.accountId !== id ||
        !Object.hasOwn(roleOperations, member.role) ||
        !["active", "revoked"].includes(member.status)
      )
        bad();
      if (member.role === "owner" && member.status === "active") owners++;
    }
    if (
      !owners ||
      !Object.hasOwn(value.memberships, value.creation.personId) ||
      !Object.hasOwn(value.entitlements, value.creation.product)
    )
      bad();
    for (const [product, entitlement] of Object.entries(value.entitlements))
      if (
        !product ||
        !record(entitlement) ||
        entitlement.product !== product ||
        entitlement.accountId !== id ||
        !["active", "disabled"].includes(entitlement.status) ||
        !Array.isArray(entitlement.capabilities) ||
        entitlement.capabilities.some((operation) => !roleOperations.owner.includes(operation))
      )
        bad();
    if (value.audit.length !== value.account.revision) bad();
    for (let index = 0; index < value.audit.length; index++) {
      const event = value.audit[index];
      if (
        !record(event) ||
        event.revision !== index + 1 ||
        !["account.created", "membership.changed", "entitlement.changed"].includes(event.type) ||
        !UUID_PATTERN.test(event.actor) ||
        !timestamp(event.at) ||
        typeof event.product !== "string" ||
        typeof event.principal !== "string"
      )
        bad();
      if (
        index === 0 &&
        (event.type !== "account.created" ||
          event.actor !== value.creation.personId ||
          event.product !== value.creation.product)
      )
        bad();
      if (
        index > 0 &&
        event.type === "membership.changed" &&
        (!UUID_PATTERN.test(event.target ?? "") ||
          !event.role ||
          !Object.hasOwn(roleOperations, event.role) ||
          !["active", "revoked"].includes(event.status ?? ""))
      )
        bad();
      if (
        index > 0 &&
        event.type === "entitlement.changed" &&
        (!Object.hasOwn(value.entitlements, event.target ?? "") ||
          event.role !== undefined ||
          !["active", "disabled"].includes(event.status ?? ""))
      )
        bad();
      if (index > 0 && event.type === "account.created") bad();
    }
  }
  async read(id: string): Promise<IdentityObject<AccountDocument> | null> {
    if (!UUID_PATTERN.test(id)) fail(400, "account", "UUID account ID required.");
    const stored = await this.files.get<AccountDocument>(path(id));
    if (stored) this.validate(stored.value, id);
    return stored;
  }
  private summary(
    context: Context,
    personId: string,
    document: AccountDocument,
    operation: Operation,
  ): AccountSummary {
    const member = Object.hasOwn(document.memberships, personId) ? document.memberships[personId] : null;
    const entitlement = Object.hasOwn(document.entitlements, context.product)
      ? document.entitlements[context.product]
      : null;
    if (
      !context.capabilities.includes(operation) ||
      !member ||
      member.status !== "active" ||
      !roleOperations[member.role].includes(operation) ||
      !entitlement ||
      entitlement.status !== "active" ||
      !entitlement.capabilities.includes(operation)
    )
      fail(403, "forbidden", "Account operation is not permitted.");
    return {
      id: document.account.id,
      name: document.account.name,
      role: member.role,
      entitlement: structuredClone(entitlement),
    };
  }
  private async allowed(context: Context, id: string, operation: Operation) {
    const person = await this.person(context);
    const stored = await this.read(id);
    if (!stored) fail(403, "forbidden", "Account operation is not permitted.");
    return { person, stored, summary: this.summary(context, person.id, stored.value, operation) };
  }
  async resolve(context: Context) {
    return this.person(context);
  }
  async list(context: Context): Promise<{ person: Person | null; accounts: AccountSummary[] }> {
    // Same current directory check as resolve; no automatic identity enrollment.
    let person: Person;
    try {
      person = await this.person(context);
    } catch (error) {
      if (error instanceof AccountsError && error.code === "identity_enrollment_required")
        return { person: null, accounts: [] };
      throw error;
    }
    const accounts: AccountSummary[] = [];
    for (const document of await this.candidateAccounts(person.id)) {
      try {
        accounts.push(this.summary(context, person.id, document, "console:read"));
      } catch (error) {
        if (!(error instanceof AccountsError && error.status === 403)) throw error;
      }
    }
    return { person, accounts: accounts.sort((a, b) => a.id.localeCompare(b.id)) };
  }
  private async listedAccountIds(prefix: string, pattern: RegExp) {
    const paths = await this.files.list(prefix);
    if (paths.length > 256) fail(503, "account_read_budget", "Account discovery budget exceeded.");
    return paths.map((candidate) => {
      const match = pattern.exec(candidate);
      if (!match) fail(503, "account_inconsistent", "Unexpected canonical account path.");
      return match[1];
    });
  }
  private async readAccountsInBatchesOfFour(accountIds: string[], skipMissingAccounts: boolean) {
    const documents: AccountDocument[] = [];
    for (let offset = 0; offset < accountIds.length; offset += 4) {
      const batch = await Promise.all(
        accountIds.slice(offset, offset + 4).map((accountId) => this.read(accountId)),
      );
      for (const stored of batch) {
        if (stored) documents.push(stored.value);
        else if (!skipMissingAccounts)
          fail(503, "account_inconsistent", "Account disappeared during discovery.");
      }
    }
    return documents;
  }
  async allAccounts() {
    return this.readAccountsInBatchesOfFour(
      await this.listedAccountIds("accounts/", /^accounts\/([a-f0-9-]{36})\.json$/),
      false,
    );
  }
  /** Candidates may include accounts the person has since left; callers check the membership. */
  async candidateAccounts(personId: string) {
    if (this.membershipLookup === "scan") return this.allAccounts();
    if (!UUID_PATTERN.test(personId)) fail(400, "invalid_person", "UUID person ID required.");
    const accountIds = await this.listedAccountIds(
      `members/${personId}/`,
      new RegExp(`^members/${personId}/([a-f0-9-]{36})\\.json$`),
    );
    return this.readAccountsInBatchesOfFour(accountIds, true);
  }
  private async recordMembershipMarker(personId: string, accountId: string) {
    const logical = ["account-membership-marker-v1", personId, accountId];
    try {
      await this.publish(
        membershipMarkerPath(personId, accountId),
        `membership-marker:${personId}:${accountId}`,
        hash(logical),
        { version: 1, kind: "membership-marker", personId, accountId },
        null,
      );
    } catch (error) {
      if (!(error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code)))
        throw error;
    }
  }
  /** Backfills markers for accounts published before markers existed. Idempotent. */
  async rebuildMembershipIndex() {
    const documents = await this.allAccounts();
    let markers = 0;
    for (const document of documents)
      for (const member of Object.values(document.memberships))
        if (member.status === "active") {
          await this.recordMembershipMarker(member.personId, document.account.id);
          markers++;
        }
    return { accounts: documents.length, markers };
  }
  async create(context: Context, name: string, requestId: string): Promise<AccountSummary> {
    if (!UUID_PATTERN.test(requestId) || typeof name !== "string" || !name.trim() || name.trim().length > 150)
      fail(400, "invalid", "UUID idempotency key and account name required.");
    const person = await this.person(context);
    if (!context.capabilities.includes("console:read"))
      fail(403, "product_forbidden", "Product cannot provision accounts.");
    name = name.trim();
    const id = createdAccountId(person.id, context.product, requestId),
      requestHash = hash([person.id, context.product, requestId.toLowerCase()]),
      fingerprint = hash({ name, product: context.product });
    const existing = await this.read(id);
    if (existing) {
      if (
        existing.value.creation.personId !== person.id ||
        existing.value.creation.product !== context.product ||
        existing.value.creation.requestHash !== requestHash ||
        existing.value.creation.fingerprint !== fingerprint
      )
        fail(409, "idempotency_conflict", "Request key belongs to different account input.");
      return this.summary(context, person.id, existing.value, "console:read");
    }
    const at = this.now();
    const document: AccountDocument = {
      version: 1,
      kind: "account",
      account: { id, name, createdAt: at, revision: 1 },
      creation: { personId: person.id, product: context.product, requestHash, fingerprint },
      memberships: { [person.id]: { accountId: id, personId: person.id, role: "owner", status: "active" } },
      entitlements: {
        [context.product]: {
          accountId: id,
          product: context.product,
          status: "active",
          capabilities: [...context.capabilities],
        },
      },
      audit: [
        {
          type: "account.created",
          revision: 1,
          actor: person.id,
          product: context.product,
          principal: context.principal,
          at,
        },
      ],
    };
    this.validate(document, id);
    await this.recordMembershipMarker(person.id, id);
    try {
      await this.publish(
        path(id),
        `account:${id}:create`,
        hash(["account-create-v1", id, requestHash, fingerprint]),
        document,
        null,
      );
    } catch (error) {
      if (error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code)) {
        const winner = await this.read(id);
        if (!winner || winner.value.creation.fingerprint !== fingerprint)
          fail(409, "idempotency_conflict", "Request key belongs to different account input.");
      } else throw error;
    }
    // Journal recovery can publish a frozen first decision; always re-read canonical authority.
    const committed = await this.read(id);
    if (!committed) fail(503, "accounts_unavailable", "Canonical account publication unavailable.");
    if (
      committed.value.creation.requestHash !== requestHash ||
      committed.value.creation.fingerprint !== fingerprint
    )
      fail(409, "idempotency_conflict", "Request key belongs to different account input.");
    return this.summary(context, person.id, committed.value, "console:read");
  }
  async get(context: Context, id: string) {
    return (await this.allowed(context, id, "console:read")).summary;
  }
  async authorize(context: Context, id: string, operation: Operation): Promise<AccountAuthorization> {
    if (!roleOperations.owner.includes(operation))
      fail(400, "invalid_operation", "Unknown account operation.");
    const state = await this.allowed(context, id, operation);
    return {
      allowed: true,
      accountId: id,
      personId: state.person.id,
      product: context.product,
      role: state.summary.role,
      operation,
      revision: state.stored.value.account.revision,
    };
  }
  async setMembership(
    context: Context,
    id: string,
    personId: string,
    role: Role,
    status: Membership["status"],
  ): Promise<Membership> {
    if (
      !UUID_PATTERN.test(personId) ||
      !Object.hasOwn(roleOperations, role) ||
      !["active", "revoked"].includes(status)
    )
      fail(400, "invalid_membership", "Known Person and valid membership required.");
    let targetPersonVerified = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await this.allowed(context, id, "members:write");
      if (!targetPersonVerified) {
        if (!(await this.directory.get(personId)))
          fail(404, "unknown_person", "Committed canonical Person required; no invitation is sent.");
        targetPersonVerified = true;
      }
      const document = structuredClone(state.stored.value),
        prior = Object.hasOwn(document.memberships, personId) ? document.memberships[personId] : null;
      if (prior?.role === role && prior.status === status) return structuredClone(prior);
      if (state.summary.role !== "owner" && (role === "owner" || prior?.role === "owner"))
        fail(403, "owner_required", "Only an owner may change ownership.");
      if (!prior && Object.keys(document.memberships).length >= 100)
        fail(409, "membership_limit", "Account membership capacity reached.");
      if (document.audit.length >= 128)
        fail(409, "account_capacity", "Account audit capacity reached; no history is discarded.");
      const membership: Membership = { accountId: id, personId, role, status };
      document.memberships[personId] = membership;
      if (
        !Object.values(document.memberships).some(
          (member) => member.status === "active" && member.role === "owner",
        )
      )
        fail(409, "last_owner", "Account must retain an active owner.");
      document.account.revision++;
      document.audit.push({
        type: "membership.changed",
        revision: document.account.revision,
        actor: state.person.id,
        target: personId,
        role,
        status,
        product: context.product,
        principal: context.principal,
        at: this.now(),
      });
      if (Buffer.byteLength(JSON.stringify(document)) > 65536)
        fail(409, "account_capacity", "Account canonical byte capacity reached.");
      this.validate(document, id);
      const logical = [
        "account-membership-v1",
        id,
        state.stored.revision,
        state.person.id,
        context.product,
        context.principal,
        personId,
        role,
        status,
      ];
      if (status === "active") await this.recordMembershipMarker(personId, id);
      try {
        await this.publish(
          path(id),
          `account:${id}:membership:${hash(logical)}`,
          hash(logical),
          document,
          state.stored.revision,
        );
        return membership;
      } catch (error) {
        if (!(error instanceof IdentityFileError && error.code === "conflict")) throw error;
      }
    }
    fail(409, "busy", "Concurrent account change; retry.");
  }
  /** Operator-only. The caller must already hold a reviewed entitlements grant; disabling keeps all account data. */
  async setEntitlement(
    operator: Context,
    id: string,
    grantedProduct: { product: string; capabilities: readonly Operation[] },
    status: Entitlement["status"],
  ): Promise<Entitlement> {
    if (!["active", "disabled"].includes(status) || !/^[a-z][a-z0-9-]{0,39}$/.test(grantedProduct.product))
      fail(400, "invalid_entitlement", "Registered product and active or disabled status required.");
    const capabilities = roleOperations.owner.filter((operation) =>
      grantedProduct.capabilities.includes(operation),
    );
    for (let attempt = 0; attempt < 12; attempt++) {
      const person = await this.person(operator),
        stored = await this.read(id);
      if (!stored) fail(404, "account_missing", "Account not found.");
      const document = structuredClone(stored.value),
        prior = Object.hasOwn(document.entitlements, grantedProduct.product)
          ? document.entitlements[grantedProduct.product]
          : null;
      const capabilitiesKeptWhileDisabled = prior ? prior.capabilities : capabilities;
      const entitlement: Entitlement = {
        accountId: id,
        product: grantedProduct.product,
        status,
        capabilities: [...(status === "active" ? capabilities : capabilitiesKeptWhileDisabled)],
      };
      if (
        prior &&
        prior.status === entitlement.status &&
        JSON.stringify(prior.capabilities) === JSON.stringify(entitlement.capabilities)
      )
        return structuredClone(prior);
      if (document.audit.length >= 128)
        fail(409, "account_capacity", "Account audit capacity reached; no history is discarded.");
      document.entitlements[grantedProduct.product] = entitlement;
      document.account.revision++;
      document.audit.push({
        type: "entitlement.changed",
        revision: document.account.revision,
        actor: person.id,
        target: grantedProduct.product,
        status,
        product: operator.product,
        principal: operator.principal,
        at: this.now(),
      });
      if (Buffer.byteLength(JSON.stringify(document)) > 65536)
        fail(409, "account_capacity", "Account canonical byte capacity reached.");
      this.validate(document, id);
      const logical = [
        "account-entitlement-v1",
        id,
        stored.revision,
        person.id,
        operator.product,
        operator.principal,
        grantedProduct.product,
        status,
        entitlement.capabilities,
      ];
      try {
        await this.publish(
          path(id),
          `account:${id}:entitlement:${hash(logical)}`,
          hash(logical),
          document,
          stored.revision,
        );
        return entitlement;
      } catch (error) {
        if (!(error instanceof IdentityFileError && error.code === "conflict")) throw error;
      }
    }
    fail(409, "busy", "Concurrent account change; retry.");
  }
}
