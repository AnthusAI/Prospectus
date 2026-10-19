import { createHash, randomUUID } from "node:crypto";
import { IdentityFileError, type IdentityFiles, type IdentityObject } from "./identity-files";
import {
  GOOGLE_ISSUER,
  sameBinding,
  type GoogleAlias,
  type GoogleAssociation,
  type GoogleIdentityRepository,
  type IdentitySession,
  type LoginChallenge,
} from "./google-identity";
import { fail, UUID_PATTERN, type Person } from "./model";
import { failWith, requireRules, rule, type ValidationRule } from "./validation-rules";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const googleIdentityKey = (subject: string) => hash(["google-v1", GOOGLE_ISSUER, subject]);
export const cognitoAliasKey = (issuer: string, subject: string) => hash(["cognito-v1", issuer, subject]);
export type EnrollmentPhase = "issue" | "prepare" | "google" | "alias" | "person" | "session" | "complete";
export type EnrollmentHook = (phase: EnrollmentPhase, point: "before" | "after") => void | Promise<void>;
const SESSION_POINTER_READ_BATCH_SIZE = 4;
const loginStates = ["pending", "prepared", "committed", "conflicted"];
const inconsistentIdentity = (summary: string) => failWith(503, "identity_inconsistent", summary);
interface GoogleRecord {
  version: 1;
  kind: "google";
  issuer: string;
  subject: string;
  person: Person;
}
interface AliasRecord {
  version: 1;
  kind: "alias";
  issuer: string;
  subject: string;
  googleKey: string;
  personId: string;
  createdAt: string;
}
interface LoginRecord {
  version: 1;
  kind: "login";
  state: "pending" | "prepared" | "committed" | "conflicted";
  challenge: LoginChallenge;
  proof?: GoogleAssociation;
  candidate?: Person;
  person?: Person;
}
interface SessionPointer {
  version: 1;
  kind: "session";
  challengeId: string;
  googleKey: string;
  aliasKey: string;
  personId: string;
}

interface PersonPointer {
  version: number;
  kind: string;
  googleKey: string;
  person: Person;
}

interface ChallengeFreshness {
  challenge: LoginChallenge;
  proof: GoogleAssociation;
}

interface CommittedLinks {
  login: LoginRecord;
  pointer: SessionPointer;
  google: GoogleRecord;
}

const loginRecordRules = (challengeId: string): ValidationRule<LoginRecord>[] => [
  rule((record) => record?.version === 1, "A login record must be version 1."),
  rule((record) => record.kind === "login", "A login record must have kind login."),
  rule(
    (record) => record.challenge?.challengeId === challengeId,
    "A login record must belong to its challenge.",
  ),
  rule((record) => loginStates.includes(record.state), "A login record must have a known state."),
];

const challengeFreshnessRules: ValidationRule<ChallengeFreshness>[] = [
  rule(({ challenge, proof }) => !(challenge.expiresAt <= proof.now), "The challenge has expired."),
  rule(
    ({ challenge, proof }) => !(challenge.issuedAt > proof.now),
    "The challenge was issued after the evidence time.",
  ),
  rule(
    ({ challenge, proof }) => challenge.nonce === proof.nonce,
    "The challenge nonce does not match the evidence.",
  ),
];

const googleRecordRules: ValidationRule<{ record: GoogleRecord; subject: string }>[] = [
  rule(({ record }) => record?.version === 1, "A Google record must be version 1."),
  rule(({ record }) => record.kind === "google", "A Google record must have kind google."),
  rule(({ record }) => record.issuer === GOOGLE_ISSUER, "A Google record must name the Google issuer."),
  rule(({ record, subject }) => record.subject === subject, "A Google record must match its subject."),
  rule(({ record }) => UUID_PATTERN.test(record.person?.id), "A Google record Person ID must be a UUID."),
  rule(
    ({ record }) => Number.isFinite(Date.parse(record.person?.createdAt)),
    "A Google record Person must have a valid creation time.",
  ),
];

const enrollmentIntentRules: ValidationRule<{ record: LoginRecord; proof: GoogleAssociation }>[] = [
  rule(
    ({ record, proof }) => proof.challengeId === record.challenge.challengeId,
    "The proof must belong to the login challenge.",
  ),
  rule(
    ({ record, proof }) => sameBinding(proof.binding, record.challenge.binding),
    "The proof binding must match the challenge binding.",
  ),
];

const committedLinkRules: ValidationRule<CommittedLinks>[] = [
  rule(({ login }) => !!login.proof, "The committed login carries no proof."),
  rule(
    ({ login, google }) => login.proof!.googleSubject === google.subject,
    "The committed proof names a different Google subject.",
  ),
  rule(
    ({ login, pointer }) =>
      cognitoAliasKey(login.proof!.binding.issuer, login.proof!.cognitoSubject) === pointer.aliasKey,
    "The committed proof names a different Cognito alias.",
  ),
  rule(
    ({ login }) => sameBinding(login.proof!.binding, login.challenge.binding),
    "The committed proof binding differs from the challenge binding.",
  ),
  rule(
    ({ login, google }) => hash(login.person) === hash(google.person),
    "The committed login Person differs from the Google Person.",
  ),
];

const committedAliasRules: ValidationRule<CommittedLinks & { alias: AliasRecord | undefined }>[] = [
  rule(({ alias }) => !!alias, "The alias record is missing."),
  rule(
    ({ alias, pointer }) => alias!.googleKey === pointer.googleKey,
    "The alias names a different Google identity.",
  ),
  rule(({ alias, pointer }) => alias!.personId === pointer.personId, "The alias names a different Person."),
  rule(
    ({ alias, login }) => alias!.issuer === login.proof!.binding.issuer,
    "The alias names a different issuer.",
  ),
  rule(
    ({ alias, login }) => alias!.subject === login.proof!.cognitoSubject,
    "The alias names a different subject.",
  ),
];

const committedPersonRules: ValidationRule<{
  person: PersonPointer | undefined;
  pointer: SessionPointer;
  google: GoogleRecord;
}>[] = [
  rule(({ person }) => !!person, "The Person lookup record is missing."),
  rule(({ person }) => person!.version === 1, "The Person lookup record must be version 1."),
  rule(({ person }) => person!.kind === "person", "The Person lookup record must have kind person."),
  rule(
    ({ person, pointer }) => person!.googleKey === pointer.googleKey,
    "The Person lookup record names a different Google identity.",
  ),
  rule(
    ({ person, google }) => hash(person!.person) === hash(google.person),
    "The Person lookup record holds a different Person.",
  ),
];

const canonicalAliasRules: ValidationRule<{ alias: AliasRecord; issuer: string; subject: string }>[] = [
  rule(({ alias }) => alias.version === 1, "An alias record must be version 1."),
  rule(({ alias }) => alias.kind === "alias", "An alias record must have kind alias."),
  rule(({ alias, issuer }) => alias.issuer === issuer, "An alias record must name the looked-up issuer."),
  rule(({ alias, subject }) => alias.subject === subject, "An alias record must name the looked-up subject."),
];

const aliasGoogleAgreementRules: ValidationRule<{ alias: AliasRecord; google: GoogleRecord }>[] = [
  rule(
    ({ alias, google }) => alias.googleKey === googleIdentityKey(google.subject),
    "The alias key does not match the Google identity.",
  ),
  rule(
    ({ alias, google }) => alias.personId === google.person.id,
    "The alias Person does not match the Google Person.",
  ),
];

const personPointerRules: ValidationRule<{
  pointer: PersonPointer;
  google: GoogleRecord;
  personId: string;
}>[] = [
  rule(({ pointer }) => pointer.kind === "person", "A Person pointer must have kind person."),
  rule(({ pointer }) => pointer.version === 1, "A Person pointer must be version 1."),
  rule(
    ({ google, personId }) => google.person.id === personId,
    "A Person pointer must resolve to the same Person ID.",
  ),
  rule(
    ({ pointer, google }) => hash(pointer.person) === hash(google.person),
    "A Person pointer must hold the Google Person.",
  ),
  rule(
    ({ pointer, google }) => pointer.googleKey === googleIdentityKey(google.subject),
    "A Person pointer must name the Google identity.",
  ),
];

const googleRecordMatches = (value: GoogleRecord | undefined, googleSubject: string) =>
  value?.kind === "google" && value.issuer === GOOGLE_ISSUER && value.subject === googleSubject;

const aliasRecordMatches = (
  value: AliasRecord | undefined,
  expected: Pick<AliasRecord, "issuer" | "subject" | "googleKey" | "personId">,
) =>
  value?.version === 1 &&
  value.kind === "alias" &&
  value.issuer === expected.issuer &&
  value.subject === expected.subject &&
  value.googleKey === expected.googleKey &&
  value.personId === expected.personId;

const personRecordMatches = (value: PersonPointer | undefined, googleKey: string, person: Person) =>
  value?.version === 1 &&
  value.kind === "person" &&
  value.googleKey === googleKey &&
  hash(value.person) === hash(person);

const sessionPointerMatches = (
  value: SessionPointer | undefined,
  expected: Omit<SessionPointer, "version" | "kind">,
) =>
  value?.version === 1 &&
  value.kind === "session" &&
  value.challengeId === expected.challengeId &&
  value.googleKey === expected.googleKey &&
  value.aliasKey === expected.aliasKey &&
  value.personId === expected.personId;

const sessionPointerBelongsToGoogleIdentity = (
  pointer: SessionPointer,
  google: GoogleRecord,
  aliasKey: string | undefined,
) =>
  pointer?.version === 1 &&
  pointer.kind === "session" &&
  pointer.personId === google.person.id &&
  pointer.googleKey === googleIdentityKey(google.subject) &&
  (!aliasKey || pointer.aliasKey === aliasKey);

/** Recoverable multi-file enrollment. Only committed logins expose identities.
 * All writes use Virtuus journals/CAS; no process mutex, lease timeout or DDB.
 * Files may reserve an identity before completion but can never grant access then.
 */
export class DurableGoogleIdentities implements GoogleIdentityRepository {
  constructor(
    private files: IdentityFiles,
    private hook: EnrollmentHook = () => {},
  ) {}
  private async step<T>(phase: EnrollmentPhase, work: () => Promise<T>): Promise<T> {
    await this.hook(phase, "before");
    const result = await work();
    await this.hook(phase, "after");
    return result;
  }
  private write<T>(
    path: string,
    operationId: string,
    value: T,
    revision: string | null,
    logical: unknown = value,
  ) {
    return this.files.commit(path, operationId, hash(["identity-v1", path, logical]), value, revision);
  }
  async issue(challenge: LoginChallenge) {
    await this.step("issue", () =>
      this.write(
        `logins/${challenge.challengeId}.json`,
        `identity:${challenge.challengeId}:issue`,
        { version: 1, kind: "login", state: "pending", challenge } satisfies LoginRecord,
        null,
      ),
    );
  }
  private loginValid(record: LoginRecord, id: string) {
    requireRules(record, loginRecordRules(id), inconsistentIdentity("Invalid canonical login record"));
  }
  async associate(proof: GoogleAssociation): Promise<Person> {
    const path = `logins/${proof.challengeId}.json`;
    let stored = await this.files.get<LoginRecord>(path);
    if (!stored) fail(401, "challenge_invalid", "Challenge does not exist.");
    this.loginValid(stored.value, proof.challengeId);
    const prior = stored.value;
    requireRules(
      { challenge: prior.challenge, proof },
      challengeFreshnessRules,
      failWith(401, "challenge_invalid", "Challenge expired or does not match evidence"),
    );
    if (!sameBinding(prior.challenge.binding, proof.binding))
      fail(403, "challenge_binding", "Challenge belongs to another product/client/policy.");
    if (prior.proof && prior.proof.fingerprint !== proof.fingerprint)
      fail(409, "challenge_replay", "Challenge already consumed with different evidence.");
    if (prior.state === "conflicted") fail(409, "identity_conflict", "Existing identity mapping conflicts.");
    if (prior.state === "pending") {
      const prepared: LoginRecord = {
        ...prior,
        state: "prepared",
        proof: structuredClone(proof),
        candidate: { id: randomUUID(), createdAt: new Date(proof.now * 1000).toISOString() },
      };
      try {
        stored = await this.step("prepare", () =>
          this.write(path, `identity:${proof.challengeId}:prepare`, prepared, stored!.revision, {
            fingerprint: proof.fingerprint,
          }),
        );
      } catch (error) {
        if (error instanceof IdentityFileError && error.code === "operation_mismatch")
          fail(409, "challenge_replay", "Challenge already claimed with different evidence.");
        throw error;
      }
    }
    return this.finish(stored);
  }
  /** Trusted internal repair only. Never accepts JWTs or authorizes an API caller.
   * Prepared decisions survive expiry; the API still requires fresh valid proofs.
   */
  async recover(challengeId: string): Promise<Person | null> {
    if (!UUID_PATTERN.test(challengeId)) fail(400, "challenge_invalid", "Invalid challenge ID.");
    const stored = await this.files.get<LoginRecord>(`logins/${challengeId}.json`);
    if (!stored) return null;
    this.loginValid(stored.value, challengeId);
    if (stored.value.state === "pending") return null;
    if (stored.value.state === "conflicted")
      fail(409, "identity_conflict", "Existing identity mapping conflicts.");
    return this.finish(stored);
  }
  private checkGoogle(value: GoogleRecord, subject: string) {
    requireRules(
      { record: value, subject },
      googleRecordRules,
      inconsistentIdentity("Canonical Google identity is inconsistent"),
    );
  }
  private async ensure<T>(
    path: string,
    operation: string,
    value: T,
    accept: (current: T) => boolean,
  ): Promise<T> {
    try {
      await this.write(path, operation, value, null);
    } catch (error) {
      if (!(error instanceof IdentityFileError && error.code === "conflict")) throw error;
    }
    const current = await this.files.get<T>(path);
    if (!current || !accept(current.value))
      fail(409, "identity_conflict", "Canonical identity reservation conflicts; no automatic merge.");
    return current.value;
  }
  private async finish(stored: IdentityObject<LoginRecord>): Promise<Person> {
    const record = stored.value;
    const proof = record.proof;
    const candidate = record.candidate;
    if (!proof)
      fail(503, "identity_inconsistent", "Enrollment intent is incomplete: the login carries no proof.");
    if (!candidate)
      fail(
        503,
        "identity_inconsistent",
        "Enrollment intent is incomplete: the login carries no candidate Person.",
      );
    requireRules(
      { record, proof },
      enrollmentIntentRules,
      inconsistentIdentity("Enrollment intent is incomplete"),
    );
    const id = record.challenge.challengeId,
      googleKey = googleIdentityKey(proof.googleSubject),
      aliasKey = cognitoAliasKey(proof.binding.issuer, proof.cognitoSubject);
    const google = await this.step("google", () =>
      this.ensure<GoogleRecord>(
        `google/${googleKey}.json`,
        `identity:${id}:google`,
        {
          version: 1,
          kind: "google",
          issuer: GOOGLE_ISSUER,
          subject: proof.googleSubject,
          person: candidate,
        },
        (value) => googleRecordMatches(value, proof.googleSubject),
      ),
    );
    this.checkGoogle(google, proof.googleSubject);
    try {
      await this.step("alias", () =>
        this.ensure<AliasRecord>(
          `aliases/${aliasKey}.json`,
          `identity:${id}:alias`,
          {
            version: 1,
            kind: "alias",
            issuer: proof.binding.issuer,
            subject: proof.cognitoSubject,
            googleKey,
            personId: google.person.id,
            createdAt: new Date(proof.now * 1000).toISOString(),
          },
          (value) =>
            aliasRecordMatches(value, {
              issuer: proof.binding.issuer,
              subject: proof.cognitoSubject,
              googleKey,
              personId: google.person.id,
            }),
        ),
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "identity_conflict" &&
        record.state !== "committed"
      )
        await this.write(
          `logins/${id}.json`,
          `identity:${id}:conflicted`,
          { ...record, state: "conflicted" },
          stored.revision,
        );
      throw error;
    }
    await this.step("person", () =>
      this.ensure(
        `people/${google.person.id}.json`,
        `identity:${id}:person`,
        { version: 1, kind: "person", googleKey, person: google.person },
        (value) => personRecordMatches(value, googleKey, google.person),
      ),
    );
    await this.step("session", () =>
      this.ensure<SessionPointer>(
        `sessions/${googleKey}/${aliasKey}/${id}.json`,
        `identity:${id}:session`,
        { version: 1, kind: "session", challengeId: id, googleKey, aliasKey, personId: google.person.id },
        (value) =>
          sessionPointerMatches(value, {
            challengeId: id,
            googleKey,
            aliasKey,
            personId: google.person.id,
          }),
      ),
    );
    if (record.state !== "committed")
      await this.step("complete", () =>
        this.write(
          `logins/${id}.json`,
          `identity:${id}:complete`,
          { ...record, state: "committed", person: google.person } satisfies LoginRecord,
          stored.revision,
        ),
      );
    return google.person;
  }
  private async committed(
    pointer: SessionPointer,
    google: GoogleRecord,
    aliasKey?: string,
    read: IdentityFiles["get"] = this.files.get.bind(this.files),
  ): Promise<LoginRecord | null> {
    if (!sessionPointerBelongsToGoogleIdentity(pointer, google, aliasKey)) return null;
    const login = (await read<LoginRecord>(`logins/${pointer.challengeId}.json`))?.value;
    if (!login || login.state !== "committed") return null;
    this.loginValid(login, pointer.challengeId);
    requireRules(
      { login, pointer, google },
      committedLinkRules,
      inconsistentIdentity("Committed enrollment links are inconsistent"),
    );
    const alias = (await read<AliasRecord>(`aliases/${pointer.aliasKey}.json`))?.value;
    requireRules(
      { login, pointer, google, alias },
      committedAliasRules,
      inconsistentIdentity("Committed alias is inconsistent"),
    );
    const person = (await read<PersonPointer>(`people/${google.person.id}.json`))?.value;
    requireRules(
      { person, pointer, google },
      committedPersonRules,
      inconsistentIdentity("Committed Person lookup is incomplete"),
    );
    return login;
  }
  private memoizedReadsForOneLookup(): IdentityFiles["get"] {
    const pendingReadsByPath = new Map<string, Promise<IdentityObject | null>>();
    return (path) => {
      let pendingRead = pendingReadsByPath.get(path);
      if (!pendingRead) {
        pendingRead = this.files.get(path);
        pendingReadsByPath.set(path, pendingRead);
      }
      return pendingRead;
    };
  }
  async find(issuer: string, subject: string, _session?: IdentitySession) {
    // Immutable identity links are shared only within this lookup. Every later
    // request rereads canonical authority; no mutable account permissions cache.
    const read = this.memoizedReadsForOneLookup();
    const aliasKey = cognitoAliasKey(issuer, subject);
    const alias = (await read<AliasRecord>(`aliases/${aliasKey}.json`))?.value;
    if (!alias) return null;
    requireRules(
      { alias, issuer, subject },
      canonicalAliasRules,
      inconsistentIdentity("Invalid canonical alias"),
    );
    const google = (await read<GoogleRecord>(`google/${alias.googleKey}.json`))?.value;
    if (!google) fail(503, "identity_inconsistent", "Missing Google identity.");
    this.checkGoogle(google, google.subject);
    requireRules(
      { alias, google },
      aliasGoogleAgreementRules,
      inconsistentIdentity("Canonical alias conflicts"),
    );
    const logins: LoginRecord[] = [];
    const paths = await this.files.list(`sessions/${alias.googleKey}/${aliasKey}/`);
    for (let offset = 0; offset < paths.length; offset += 4) {
      const batch = await Promise.all(
        paths.slice(offset, offset + 4).map(async (path) => {
          const pointer = (await read<SessionPointer>(path))?.value;
          return pointer ? this.committed(pointer, google, aliasKey, read) : null;
        }),
      );
      for (const login of batch) if (login) logins.push(login);
    }
    if (!logins.length) return null;
    return {
      person: google.person,
      alias: {
        issuer,
        subject,
        personId: google.person.id,
        googleIssuer: GOOGLE_ISSUER,
        googleSubject: google.subject,
        createdAt: alias.createdAt,
        provenance: logins.map((login) => login.proof!.binding),
        sessions: logins.map((login) => ({
          binding: login.proof!.binding,
          authTime: login.proof!.authTime,
          lineageHash: login.proof!.lineageHash,
        })),
      } satisfies GoogleAlias,
    };
  }
  async getPerson(id: string): Promise<Person | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const readMemoizedForThisLookup = this.memoizedReadsForOneLookup();
    const pointer = (await readMemoizedForThisLookup<PersonPointer>(`people/${id}.json`))?.value;
    if (!pointer) return null;
    const google = (await readMemoizedForThisLookup<GoogleRecord>(`google/${pointer.googleKey}.json`))?.value;
    if (!google) return null;
    this.checkGoogle(google, google.subject);
    requireRules(
      { pointer, google, personId: id },
      personPointerRules,
      inconsistentIdentity("Person pointer conflicts"),
    );
    const sessionPointerPaths = await this.files.list(`sessions/${pointer.googleKey}/`);
    for (let offset = 0; offset < sessionPointerPaths.length; offset += SESSION_POINTER_READ_BATCH_SIZE) {
      const committedLogins = await Promise.all(
        sessionPointerPaths.slice(offset, offset + SESSION_POINTER_READ_BATCH_SIZE).map(async (path) => {
          const session = (await readMemoizedForThisLookup<SessionPointer>(path))?.value;
          return session ? this.committed(session, google, undefined, readMemoizedForThisLookup) : null;
        }),
      );
      if (committedLogins.some((login) => login)) return google.person;
    }
    return null;
  }
}
