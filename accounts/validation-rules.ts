import { fail } from "./model";

/** Rules run in order and stop at the first broken one, so a later rule may rely on every earlier rule holding. */
export interface ValidationRule<Subject> {
  holds: (subject: Subject) => boolean;
  failureMessage: string;
}

export const rule = <Subject>(
  holds: (subject: Subject) => boolean,
  failureMessage: string,
): ValidationRule<Subject> => ({ holds, failureMessage });

export function firstBrokenRuleMessage<Subject>(
  subject: Subject,
  rules: readonly ValidationRule<Subject>[],
): string | undefined {
  return rules.find((candidate) => !candidate.holds(subject))?.failureMessage;
}

export function requireRules<Subject>(
  subject: Subject,
  rules: readonly ValidationRule<Subject>[],
  raise: (brokenRuleMessage: string) => never,
) {
  const brokenRuleMessage = firstBrokenRuleMessage(subject, rules);
  if (brokenRuleMessage !== undefined) raise(brokenRuleMessage);
}

export const throwErrorWithPrefix =
  (messagePrefix: string) =>
  (brokenRuleMessage: string): never => {
    throw new Error(`${messagePrefix} ${brokenRuleMessage}`);
  };

export const failWith =
  (status: number, code: string, summary: string) =>
  (brokenRuleMessage: string): never =>
    fail(status, code, `${summary}: ${brokenRuleMessage}`);

export function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export const hasOnlyKeys = (value: object, allowedKeys: readonly string[]) =>
  Object.keys(value).every((key) => allowedKeys.includes(key));

export const hasExactlyKeys = (value: object, expectedSortedKeys: string) =>
  Object.keys(value).sort().join(",") === expectedSortedKeys;

export const PRODUCT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const COGNITO_ISSUER_PATTERN = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_-]+$/;
export const CLIENT_ID_PATTERN = /^[a-z0-9]{1,128}$/;
export const REVIEW_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
