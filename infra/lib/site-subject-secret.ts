/** Inline source of a create-only CloudFormation custom resource that creates one SSM SecureString secret.
 *
 * On Create (and on an Update that names a different parameter) it generates 48 random bytes and stores them, base64,
 * as an SSM SecureString with Overwrite false. An existing parameter is left exactly as it is. Update with the same
 * name and Delete do nothing, so the secret is never replaced, rotated or removed by a deployment. The value is
 * never logged, never returned to CloudFormation (NoEcho, no Data) and never part of the template.
 */
export function createOnlySecretInitializerSource(secret: {
  /** Lower-case words, for example "site subject secret". */
  label: string;
  /** The parameter's description in Parameter Store. */
  description: string;
  /** The physical resource id used before the parameter name is known. */
  fallbackId: string;
}): string {
  for (const value of Object.values(secret))
    if (!/^[A-Za-z0-9 .,:'-]+$/.test(value)) throw new Error("Secret initializer text must be plain.");
  return `"use strict";
const { SSMClient, PutParameterCommand } = require("@aws-sdk/client-ssm");
const { randomBytes } = require("node:crypto");
const ssm = new SSMClient({});
const NAME = /^\\/[A-Za-z0-9_.-]+(\\/[A-Za-z0-9_.-]+)*\\/v1$/;
async function create(name) {
  if (!NAME.test(name || "")) throw Object.assign(new Error("invalid"), { name: "InvalidParameterName" });
  try {
    await ssm.send(new PutParameterCommand({
      Name: name,
      Type: "SecureString",
      Value: randomBytes(48).toString("base64"),
      Overwrite: false,
      Description: "${secret.description}",
    }));
  } catch (error) {
    if (!error || error.name !== "ParameterAlreadyExists") throw error;
  }
}
exports.handler = async (event) => {
  const name = event.ResourceProperties && event.ResourceProperties.ParameterName;
  const previous = event.OldResourceProperties && event.OldResourceProperties.ParameterName;
  let status = "SUCCESS", reason = "The ${secret.label} exists.", physical = event.PhysicalResourceId || name;
  try {
    if (event.RequestType === "Create" || (event.RequestType === "Update" && name !== previous)) {
      await create(name);
      physical = name;
    }
  } catch (error) {
    status = "FAILED";
    reason = "The ${secret.label} could not be created (" + String((error && error.name) || "Error").slice(0, 64) + ").";
  }
  await fetch(event.ResponseURL, {
    method: "PUT",
    headers: { "content-type": "" },
    body: JSON.stringify({
      Status: status,
      Reason: reason,
      PhysicalResourceId: physical || "${secret.fallbackId}",
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      NoEcho: true,
      Data: {},
    }),
  });
};
`;
}

/** The site subject secret's initializer. Its source is unchanged by the refactor (the deployed Lambda stays as is). */
export const SITE_SUBJECT_SECRET_INITIALIZER_SOURCE = createOnlySecretInitializerSource({
  label: "site subject secret",
  description:
    "Prospectus site subject secret v1. Never rotate or replace: it would change every site subject.",
  fallbackId: "site-subject-secret",
});

/** The newsletter token key's initializer: the HMAC key behind confirmation and unsubscribe links. */
export const NEWSLETTER_TOKEN_SECRET_INITIALIZER_SOURCE = createOnlySecretInitializerSource({
  label: "newsletter token key",
  description:
    "Prospectus newsletter token key v1. Never replace: it would invalidate every unsubscribe link already sent.",
  fallbackId: "newsletter-token-key",
});
