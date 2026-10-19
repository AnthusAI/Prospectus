import { REAL_CONTACT_POLICY, type IntakeContactPolicy } from "./intake-contact-policy";

export interface IntakeAttributeRule {
  values?: string[];
  pattern?: string;
}

export interface IntakeFormThrottle {
  rate: number;
  burst: number;
}

export interface IntakeFormConfig {
  enabled: boolean;
  approval?: string;
  siteId: string;
  formId: string;
  kind: "waitlist";
  origins: string[];
  noticeVersion: string;
  owner: string;
  defaultPagePath: string;
  attributes: Record<string, IntakeAttributeRule>;
  throttle: IntakeFormThrottle;
}

export const DEMO_ROUTE_PATH = "/intake/demo";
export const DEFAULT_FORM_THROTTLE: IntakeFormThrottle = { rate: 1, burst: 2 };

const identifier = /^[a-z0-9][a-z0-9-]{1,63}$/;
const origin = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const attributeName = /^[a-z][a-z0-9_]{0,31}$/;

export function waitlistRoutePath(form: Pick<IntakeFormConfig, "formId">): string {
  return `/intake/waitlist/${form.formId}`;
}

export function waitlistLabels(form: Pick<IntakeFormConfig, "siteId">): string[] {
  return ["waitlist", `app-${form.siteId}`];
}

export function waitlistContactPolicy(form: IntakeFormConfig): IntakeContactPolicy {
  return {
    ...REAL_CONTACT_POLICY,
    noticeVersion: form.noticeVersion,
    siteId: form.siteId,
    formId: form.formId,
    staleNoticeMessage: "Reload the page to read the current privacy notice.",
  };
}

function invalid(formId: string, reason: string): never {
  throw new Error(`Intake form ${formId || "(unnamed)"} is invalid: ${reason}.`);
}

export function parseIntakeForm(raw: unknown): IntakeFormConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("", "an entry must be an object");
  const entry = raw as Record<string, unknown>;
  const formId = String(entry.formId ?? "");
  const allowedKeys = [
    "enabled",
    "approval",
    "siteId",
    "formId",
    "kind",
    "origins",
    "noticeVersion",
    "owner",
    "defaultPagePath",
    "attributes",
    "throttle",
  ];
  if (Object.keys(entry).some((key) => !allowedKeys.includes(key))) invalid(formId, "unknown setting");
  if (typeof entry.enabled !== "boolean") invalid(formId, "enabled must be true or false");
  if (entry.kind !== "waitlist") invalid(formId, "kind must be waitlist");
  if (!identifier.test(formId)) invalid(formId, "formId must be a lowercase slug");
  if (typeof entry.siteId !== "string" || !identifier.test(entry.siteId))
    invalid(formId, "siteId must be a lowercase slug");
  if (typeof entry.noticeVersion !== "string" || !identifier.test(entry.noticeVersion))
    invalid(formId, "noticeVersion must be a lowercase slug");
  if (typeof entry.owner !== "string" || !identifier.test(entry.owner))
    invalid(formId, "owner must be a lowercase slug");
  if (
    !Array.isArray(entry.origins) ||
    entry.origins.length === 0 ||
    entry.origins.some((item) => typeof item !== "string" || !origin.test(item))
  )
    invalid(formId, "origins must be https origins without paths");
  const origins = entry.origins as string[];
  if (new Set(origins).size !== origins.length) invalid(formId, "origins must be unique");
  const defaultPagePath = entry.defaultPagePath ?? "/";
  if (typeof defaultPagePath !== "string" || !/^\/[a-z0-9/_-]*$/i.test(defaultPagePath))
    invalid(formId, "defaultPagePath must be a path");
  const attributes: Record<string, IntakeAttributeRule> = {};
  const declared = entry.attributes ?? {};
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    invalid(formId, "attributes must be an object");
  for (const [name, rule] of Object.entries(declared)) {
    const candidate = rule as IntakeAttributeRule;
    const hasValues = Array.isArray(candidate?.values) && candidate.values.length > 0;
    const hasPattern = typeof candidate?.pattern === "string";
    if (!attributeName.test(name) || hasValues === hasPattern)
      invalid(formId, `attribute ${name} needs a name slug and exactly one of values or pattern`);
    if (
      hasValues &&
      candidate.values!.some((value) => typeof value !== "string" || !value || value.length > 80)
    )
      invalid(formId, `attribute ${name} has an invalid value`);
    if (hasPattern) {
      try {
        new RegExp(candidate.pattern!);
      } catch {
        invalid(formId, `attribute ${name} has an invalid pattern`);
      }
    }
    attributes[name] = hasValues ? { values: candidate.values } : { pattern: candidate.pattern };
  }
  if (Object.keys(attributes).length > 8) invalid(formId, "at most 8 attributes are allowed");
  const throttle = (entry.throttle ?? DEFAULT_FORM_THROTTLE) as IntakeFormThrottle;
  if (
    !Number.isInteger(throttle.rate) ||
    !Number.isInteger(throttle.burst) ||
    throttle.rate < 1 ||
    throttle.burst < throttle.rate ||
    throttle.burst > 20
  )
    invalid(formId, "throttle needs integer rate and burst between 1 and 20");
  if (entry.enabled && (typeof entry.approval !== "string" || entry.approval.trim().length < 20))
    invalid(formId, "an enabled form needs a recorded approval");
  return {
    enabled: entry.enabled,
    ...(typeof entry.approval === "string" ? { approval: entry.approval } : {}),
    siteId: entry.siteId as string,
    formId,
    kind: "waitlist",
    origins,
    noticeVersion: entry.noticeVersion as string,
    owner: entry.owner as string,
    defaultPagePath,
    attributes,
    throttle: { rate: throttle.rate, burst: throttle.burst },
  };
}

export function parseIntakeFormRegistry(raw: unknown): IntakeFormConfig[] {
  const forms = (raw as { forms?: unknown })?.forms;
  if (!Array.isArray(forms)) throw new Error("Intake form registry needs a forms list.");
  const parsed = forms.map(parseIntakeForm);
  const seen = new Set<string>();
  for (const form of parsed) {
    if (seen.has(form.formId)) throw new Error(`Intake form ${form.formId} is declared twice.`);
    seen.add(form.formId);
  }
  return parsed;
}

export function enabledIntakeForms(forms: readonly IntakeFormConfig[]): IntakeFormConfig[] {
  return forms.filter((form) => form.enabled);
}
