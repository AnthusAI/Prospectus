import { createHash } from "node:crypto";
import type { RestEvent } from "./auth";
import { IdentityFileError, type IdentityFiles } from "./identity-files";
import { fail, UUID_PATTERN } from "./model";
import type { ValidatedRegistrations } from "./registration";
import { jsonResponse, lowerCaseHeaders } from "./request";
import {
  isPublicReader,
  siteSubject,
  SITE_SUBJECT_PATTERN,
  SITE_SUBJECT_PREFIX,
  type RetiredSiteSubjectsRoute,
  type SiteSubjectSecret,
} from "./site-subjects";
import { isPlainRecord, matchesStringPattern } from "./validation-rules";

/** Retirements are listed by the hour they were recorded, and an hour is listed only after it has ended plus this
 * margin. A retirement write that outlives the margin is written again into the current hour, so no listed hour
 * ever gains a record after a site has read past it. */
export const RETIREMENT_SETTLE_SECONDS = 60;
export const RETIRED_SUBJECTS_PAGE_SIZE = 100;
const RETIRED_SUBJECTS_LISTING_BUDGET = 5000;
const RETIREMENT_WRITE_ATTEMPTS = 3;
const HOUR_SECONDS = 3600;
const CURSOR_PATTERN = /^\d{10}-[a-f0-9]{64}$/;
const RECORD_PATH_PATTERN = /^retired-subjects\/[a-f0-9]+\/(\d{10}-[a-f0-9]{64})\.json$/;
const RETIRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;

export type RetirementReason = "deleted" | "merged";

/** What the future Person delete and merge operations must call, once per operation, after the Person change is
 * committed. The caller supplies the public-reader products the retired Person enrolled on, from that Person's
 * committed login provenance; sites the Person never used are not told anything. */
export interface PersonRetirement {
  /** The delete or merge operation's own UUID: a retry with the same ID records the same retirement. */
  operationId: string;
  /** The deleted Person, or for a merge the Person merged away. Never stored in the record or served. */
  personId: string;
  reason: RetirementReason;
  /** Merges only: the Person that remains. Served as that Person's subject on the same site. */
  survivingPersonId?: string;
  readerProducts: readonly string[];
}

/** One retired subject as a site receives it. No Person ID, no exact time and nothing shared between sites. */
export interface RetiredSiteSubject {
  siteSubject: string;
  reason: RetirementReason;
  /** Merges only: the surviving Person's subject on the same site, so the site remaps instead of dropping. */
  survivingSiteSubject?: string;
  /** The start of the UTC hour the retirement was recorded in. */
  retiredAt: string;
}

interface RetiredSubjectRecord extends RetiredSiteSubject {
  version: 1;
  kind: "retired-site-subject";
  product: string;
  operationId: string;
}

const productDirectory = (product: string) => `retired-subjects/${Buffer.from(product).toString("hex")}/`;
const subjectHex = (subject: string) =>
  Buffer.from(subject.slice(SITE_SUBJECT_PREFIX.length), "base64url").toString("hex");
const hourKey = (seconds: number) => new Date(Math.floor(seconds) * 1000).toISOString().slice(0, 13);
const bucketOf = (seconds: number) => hourKey(seconds).replace(/[-T]/g, "");
const bucketStartSeconds = (bucket: string) =>
  Date.parse(
    `${bucket.slice(0, 4)}-${bucket.slice(4, 6)}-${bucket.slice(6, 8)}T${bucket.slice(8, 10)}:00:00Z`,
  ) / 1000;
const retiredAtOf = (bucket: string) =>
  `${bucket.slice(0, 4)}-${bucket.slice(4, 6)}-${bucket.slice(6, 8)}T${bucket.slice(8, 10)}:00:00Z`;
const settled = (bucket: string, now: number) =>
  bucketStartSeconds(bucket) + HOUR_SECONDS + RETIREMENT_SETTLE_SECONDS <= now;
const requestHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(["retired-site-subject-v1", value]))
    .digest("hex");

const sameRetirement = (left: RetiredSubjectRecord, right: RetiredSubjectRecord) =>
  left.product === right.product &&
  left.siteSubject === right.siteSubject &&
  left.reason === right.reason &&
  left.survivingSiteSubject === right.survivingSiteSubject &&
  left.retiredAt === right.retiredAt;

function validRecord(value: unknown, product: string, key: string): value is RetiredSubjectRecord {
  if (!isPlainRecord(value)) return false;
  const merged = value.reason === "merged";
  return (
    value.version === 1 &&
    value.kind === "retired-site-subject" &&
    value.product === product &&
    matchesStringPattern(value.operationId, UUID_PATTERN) &&
    matchesStringPattern(value.siteSubject, SITE_SUBJECT_PATTERN) &&
    key === `${key.slice(0, 10)}-${subjectHex(value.siteSubject)}` &&
    (value.reason === "deleted" || merged) &&
    (merged
      ? matchesStringPattern(value.survivingSiteSubject, SITE_SUBJECT_PATTERN) &&
        value.survivingSiteSubject !== value.siteSubject
      : value.survivingSiteSubject === undefined) &&
    matchesStringPattern(value.retiredAt, RETIRED_AT_PATTERN) &&
    value.retiredAt === retiredAtOf(key.slice(0, 10))
  );
}

/** Central record of retired site subjects, kept as ordinary Virtuus files in the identities project. */
export class RetiredSiteSubjects implements RetiredSiteSubjectsRoute {
  constructor(
    private files: IdentityFiles,
    private products: ValidatedRegistrations,
    private secret: SiteSubjectSecret,
    private nowSeconds: () => number = () => Date.now() / 1000,
  ) {}

  /** Records one retired subject per named reader site. Returns what each site will be shown. */
  async retirePerson(retirement: PersonRetirement): Promise<Array<RetiredSiteSubject & { product: string }>> {
    const { operationId, personId, reason, survivingPersonId, readerProducts } = retirement;
    if (!matchesStringPattern(operationId, UUID_PATTERN)) fail(400, "retirement", "Operation UUID required.");
    if (!matchesStringPattern(personId, UUID_PATTERN)) fail(400, "retirement", "Person ID required.");
    if (reason !== "deleted" && reason !== "merged") fail(400, "retirement", "Unknown retirement reason.");
    if (
      reason === "merged"
        ? !matchesStringPattern(survivingPersonId, UUID_PATTERN) || survivingPersonId === personId
        : survivingPersonId !== undefined
    )
      fail(400, "retirement", "A merge names one other surviving Person; a deletion names none.");
    if (
      !Array.isArray(readerProducts) ||
      readerProducts.length === 0 ||
      new Set(readerProducts).size !== readerProducts.length ||
      readerProducts.some(
        (product) => !isPublicReader(this.products.find((registration) => registration.product === product)),
      )
    )
      fail(400, "retirement", "Distinct registered public-reader products required.");
    const recorded: Array<RetiredSiteSubject & { product: string }> = [];
    for (const product of readerProducts) {
      const subject = await siteSubject(this.secret, product, personId);
      const surviving =
        reason === "merged" ? await siteSubject(this.secret, product, survivingPersonId!) : undefined;
      recorded.push({ product, ...(await this.record(operationId, product, subject, reason, surviving)) });
    }
    return recorded;
  }

  private async record(
    operationId: string,
    product: string,
    subject: string,
    reason: RetirementReason,
    surviving: string | undefined,
  ): Promise<RetiredSiteSubject> {
    for (let attempt = 0; attempt < RETIREMENT_WRITE_ATTEMPTS; attempt++) {
      const bucket = bucketOf(this.nowSeconds());
      const key = `${bucket}-${subjectHex(subject)}`;
      const path = `${productDirectory(product)}${key}.json`;
      const value: RetiredSubjectRecord = {
        version: 1,
        kind: "retired-site-subject",
        product,
        operationId,
        siteSubject: subject,
        reason,
        ...(surviving ? { survivingSiteSubject: surviving } : {}),
        retiredAt: retiredAtOf(bucket),
      };
      try {
        await this.files.commit(
          path,
          `retire:${operationId}:${product}`,
          requestHash([path, value]),
          value,
          null,
        );
      } catch (error) {
        if (!(error instanceof IdentityFileError && error.code === "conflict")) throw error;
        const current = (await this.files.get<RetiredSubjectRecord>(path))?.value;
        if (!validRecord(current, product, key) || !sameRetirement(current, value))
          fail(409, "retirement_conflict", "A different retirement is recorded for this subject.");
      }
      // Still inside the hour's listing margin: no site can have read past this record.
      if (!settled(bucket, this.nowSeconds())) {
        return {
          siteSubject: subject,
          reason,
          ...(surviving ? { survivingSiteSubject: surviving } : {}),
          retiredAt: value.retiredAt,
        };
      }
    }
    fail(503, "retirement_unavailable", "The retirement could not be recorded in time; retry the operation.");
  }

  /** The caller's own retired subjects after `since`, oldest first, from hours that have ended. */
  async list(product: string, since: string | undefined, now: number) {
    if (since !== undefined && !matchesStringPattern(since, CURSOR_PATTERN))
      fail(400, "cursor", "The cursor is malformed.");
    const directory = productDirectory(product);
    const paths = await this.files.list(directory);
    if (paths.length > RETIRED_SUBJECTS_LISTING_BUDGET)
      fail(503, "retired_subjects_budget", "Retired subject listing budget exceeded.");
    const keys = paths
      .map((path) => {
        const match = RECORD_PATH_PATTERN.exec(path);
        if (!match || !path.startsWith(directory))
          fail(503, "retired_subjects_inconsistent", "Unexpected retired subject path.");
        return match[1];
      })
      .filter((key) => (since === undefined || key > since) && settled(key.slice(0, 10), now))
      .sort();
    const page = keys.slice(0, RETIRED_SUBJECTS_PAGE_SIZE);
    const retired: RetiredSiteSubject[] = [];
    for (let offset = 0; offset < page.length; offset += 4) {
      const batch = await Promise.all(
        page.slice(offset, offset + 4).map(async (key) => {
          const value = (await this.files.get(`${directory}${key}.json`))?.value;
          if (!validRecord(value, product, key))
            fail(503, "retired_subjects_inconsistent", "A retired subject record is invalid.");
          return {
            siteSubject: value.siteSubject,
            reason: value.reason,
            ...(value.survivingSiteSubject ? { survivingSiteSubject: value.survivingSiteSubject } : {}),
            retiredAt: value.retiredAt,
          };
        }),
      );
      retired.push(...batch);
    }
    return {
      retired,
      cursor: page.length ? page[page.length - 1] : (since ?? null),
      more: keys.length > page.length,
    };
  }

  async respond(event: RestEvent, product: string, now: number) {
    if (event.httpMethod !== "GET") fail(404, "route", "Identity route not found.");
    lowerCaseHeaders(event.headers);
    if (event.body || event.isBase64Encoded) fail(400, "body", "No request body is accepted.");
    const query = event.queryStringParameters ?? {};
    const multi = event.multiValueQueryStringParameters ?? {};
    if (
      Object.keys(query).some((key) => key !== "since") ||
      Object.keys(multi).some((key) => key !== "since") ||
      (multi.since?.length ?? 0) > 1
    )
      fail(400, "query", "Only one since cursor is accepted.");
    return jsonResponse(200, await this.list(product, query.since ?? undefined, now));
  }
}
