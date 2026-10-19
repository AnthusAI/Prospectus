import { randomUUID } from "node:crypto";
import { fail, type Person } from "../model";
import {
  GOOGLE_ISSUER,
  sameBinding,
  type GoogleAlias,
  type GoogleAssociation,
  type GoogleIdentityRepository,
  type LoginChallenge,
} from "../google-identity";

/** Synthetic local test adapter only: synchronous critical section, no awaits.
 * Does not claim cross-process durability or implement a cloud storage choice.
 */
export class MemoryGoogleIdentities implements GoogleIdentityRepository {
  private challenges = new Map<
    string,
    LoginChallenge & { receipt?: { fingerprint: string; person: Person } }
  >();
  private people = new Map<string, Person>();
  private google = new Map<string, string>();
  private aliases = new Map<string, GoogleAlias>();
  private audit: Array<{
    challengeId: string;
    personId: string;
    binding: LoginChallenge["binding"];
    at: string;
  }> = [];
  private aliasKey(issuer: string, subject: string) {
    return JSON.stringify([issuer, subject]);
  }
  async issue(challenge: LoginChallenge): Promise<void> {
    if (this.challenges.has(challenge.challengeId))
      fail(409, "challenge_conflict", "Challenge already exists.");
    for (const [id, entry] of this.challenges)
      if (entry.expiresAt <= challenge.issuedAt) this.challenges.delete(id);
    if (this.challenges.size >= 1000) fail(429, "challenge_limit", "Local challenge capacity exceeded.");
    this.challenges.set(challenge.challengeId, structuredClone(challenge));
  }
  async associate(proof: GoogleAssociation): Promise<Person> {
    const challenge = this.challenges.get(proof.challengeId);
    if (
      !challenge ||
      challenge.expiresAt <= proof.now ||
      challenge.issuedAt > proof.now ||
      challenge.nonce !== proof.nonce
    )
      fail(401, "challenge_invalid", "Challenge expired or does not match login evidence.");
    if (!sameBinding(challenge.binding, proof.binding))
      fail(403, "challenge_binding", "Challenge belongs to another product/client/policy.");
    if (challenge.receipt) {
      if (challenge.receipt.fingerprint !== proof.fingerprint)
        fail(409, "challenge_replay", "Challenge already consumed with different evidence.");
      return structuredClone(challenge.receipt.person);
    }
    const aliasKey = this.aliasKey(proof.binding.issuer, proof.cognitoSubject);
    const alias = this.aliases.get(aliasKey);
    const canonical = this.google.get(proof.googleSubject);
    if (alias && (alias.googleSubject !== proof.googleSubject || !canonical || alias.personId !== canonical))
      fail(
        409,
        "identity_conflict",
        "Existing identity mapping conflicts; explicit reconciliation required.",
      );
    if (!canonical && this.people.size >= 5000)
      fail(429, "identity_limit", "Local identity capacity exceeded.");
    const person = canonical
      ? this.people.get(canonical)
      : { id: randomUUID(), createdAt: new Date(proof.now * 1000).toISOString() };
    if (!person) fail(503, "identity_inconsistent", "Canonical identity missing.");
    const provenance = alias?.provenance ?? [];
    const sessions = alias?.sessions ?? [];
    const sessionKnown = sessions.some(
      (session) =>
        sameBinding(session.binding, proof.binding) &&
        session.authTime === proof.authTime &&
        session.lineageHash === proof.lineageHash,
    );
    if (!sessionKnown && sessions.length >= 32)
      fail(429, "session_limit", "Local synthetic session capacity exceeded.");
    const updated: GoogleAlias = {
      personId: person.id,
      issuer: proof.binding.issuer,
      subject: proof.cognitoSubject,
      googleIssuer: GOOGLE_ISSUER,
      googleSubject: proof.googleSubject,
      createdAt: alias?.createdAt ?? new Date(proof.now * 1000).toISOString(),
      provenance: provenance.some((prior) => sameBinding(prior, proof.binding))
        ? provenance
        : [...provenance, structuredClone(proof.binding)],
      sessions: sessionKnown
        ? sessions
        : [
            ...sessions,
            {
              binding: structuredClone(proof.binding),
              authTime: proof.authTime,
              lineageHash: proof.lineageHash,
            },
          ],
    };
    this.people.set(person.id, person);
    this.google.set(proof.googleSubject, person.id);
    this.aliases.set(aliasKey, updated);
    this.audit.push({
      challengeId: proof.challengeId,
      personId: person.id,
      binding: structuredClone(proof.binding),
      at: new Date(proof.now * 1000).toISOString(),
    });
    challenge.receipt = { fingerprint: proof.fingerprint, person };
    return structuredClone(person);
  }
  async find(issuer: string, subject: string) {
    const alias = this.aliases.get(this.aliasKey(issuer, subject));
    if (!alias) return null;
    const person = this.people.get(alias.personId);
    if (!person) fail(503, "identity_inconsistent", "Canonical identity missing.");
    return structuredClone({ person, alias });
  }
  async getPerson(id: string) {
    return structuredClone(this.people.get(id) ?? null);
  }
  get counts() {
    return {
      people: this.people.size,
      googleIdentities: this.google.size,
      aliases: this.aliases.size,
      associations: this.audit.length,
    };
  }
}
