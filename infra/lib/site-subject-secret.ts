/** Inline source of the create-only CloudFormation custom resource that creates the site subject secret.
 *
 * On Create (and on an Update that names a different parameter) it generates 48 random bytes and stores them, base64,
 * as an SSM SecureString with Overwrite false. An existing parameter is left exactly as it is. Update with the same
 * name and Delete do nothing, so the secret is never replaced, rotated or removed by a deployment. The value is
 * never logged, never returned to CloudFormation (NoEcho, no Data) and never part of the template.
 */
export const SITE_SUBJECT_SECRET_INITIALIZER_SOURCE = `"use strict";
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
      Description: "Prospectus site subject secret v1. Never rotate or replace: it would change every site subject.",
    }));
  } catch (error) {
    if (!error || error.name !== "ParameterAlreadyExists") throw error;
  }
}
exports.handler = async (event) => {
  const name = event.ResourceProperties && event.ResourceProperties.ParameterName;
  const previous = event.OldResourceProperties && event.OldResourceProperties.ParameterName;
  let status = "SUCCESS", reason = "The site subject secret exists.", physical = event.PhysicalResourceId || name;
  try {
    if (event.RequestType === "Create" || (event.RequestType === "Update" && name !== previous)) {
      await create(name);
      physical = name;
    }
  } catch (error) {
    status = "FAILED";
    reason = "The site subject secret could not be created (" + String((error && error.name) || "Error").slice(0, 64) + ").";
  }
  await fetch(event.ResponseURL, {
    method: "PUT",
    headers: { "content-type": "" },
    body: JSON.stringify({
      Status: status,
      Reason: reason,
      PhysicalResourceId: physical || "site-subject-secret",
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      NoEcho: true,
      Data: {},
    }),
  });
};
`;
