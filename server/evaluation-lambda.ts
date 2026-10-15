import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IntakeService } from "./intake";
import { createScopedS3ControlStore } from "./s3-control-store";
import { createEvaluationHandler } from "./evaluation-handler";
import { canonicalRequest } from "./canonical-invoke";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing evaluation configuration ${name}`);
  return value;
};
const allowedOrigin = required("PROSPECTUS_EVALUATION_ORIGIN");
const workspace = required("PROSPECTUS_EVALUATION_WORKSPACE");
const bucket = required("PROSPECTUS_EVALUATION_BUCKET");
const region = required("AWS_REGION");
const functionName = required("PROSPECTUS_CANONICAL_FUNCTION");
const client = new LambdaClient({ region, maxAttempts: 1 });
const request = canonicalRequest(async (event) => {
  const result = await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(event)) }));
  if (result.FunctionError || !result.Payload) throw new Error("Private CRM invocation was not confirmed.");
  return JSON.parse(Buffer.from(result.Payload).toString("utf8"));
});
const identityStore = createScopedS3ControlStore({ enabled: true, executable: "/var/task/prospectus-s3-controls", workspace, bucket, region, timeoutMs: 8000 });

export const handler = createEvaluationHandler({ allowedOrigin, open: async () => {
  // Per-invocation files are a disposable cache. Shared S3 claims and canonical
  // inquiry fingerprints remain authoritative across invocations and retries.
  const directory = await mkdtemp(join(tmpdir(), "prospectus-intake-"));
  try {
    const service = await IntakeService.open({ directory, workspace, owner: "intake-queue", siteId: "anthus-prospectus-evaluation", formId: "synthetic-demo-v1", identityStore, request });
    return { submit: service.submit.bind(service), close: async () => { await service.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (cause) { await rm(directory, { recursive: true, force: true }); throw cause; }
} });
