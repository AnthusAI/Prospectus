import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlConflict } from "../server/control-store";
import { ControlTransportError, VirtuusS3ControlStore, createStdioS3Invoker, type ControlRequest } from "../server/s3-control-store";

const path = `intake-identities/${"a".repeat(64)}.json`;
const workspace = "test/prospectus";

test("S3 transport forwards exact absent/revision conditions and opaque quoted ETags", async () => {
  const requests: ControlRequest[] = [];
  const store = new VirtuusS3ControlStore(workspace, async (request) => {
    requests.push(request);
    if (request.operation === "get") return { ...request, status: "missing" };
    return { version: 1, workspace, path, status: "ok", object: { bytes: request.bytes, revision: '"s3-etag-opaque"' } };
  });
  assert.equal(await store.getControl(path), null);
  const body = '{"message":"hello 世界"}\n';
  const first = await store.putControl(path, body, { absent: true });
  await store.putControl(path, body, { revision: first.revision });
  assert.equal(first.bytes, body); assert.equal(first.revision, '"s3-etag-opaque"');
  assert.deepEqual(requests[1].condition, { absent: true });
  assert.deepEqual(requests[2].condition, { revision: '"s3-etag-opaque"' });
});

test("S3 transport distinguishes conditional conflict and lost write response without blind retries", async () => {
  let calls = 0; let status = "conflict";
  const store = new VirtuusS3ControlStore(workspace, async (request) => { calls++; return { version: 1, workspace, path: request.path, status }; });
  await assert.rejects(store.putControl(path, "claim", { absent: true }), ControlConflict);
  status = "uncertain";
  await assert.rejects(store.putControl(path, "claim", { absent: true }), (error: unknown) => error instanceof ControlTransportError && error.outcome === "uncertain");
  assert.equal(calls, 2);
  status = "unavailable";
  await assert.rejects(store.getControl(path), (error: unknown) => error instanceof ControlTransportError && error.outcome === "unavailable");
});

test("S3 transport refuses arbitrary control paths and mismatched workspace responses", async () => {
  let calls = 0;
  const store = new VirtuusS3ControlStore(workspace, async (request) => { calls++; return { version: 1, workspace: "other/prospectus", path: request.path, status: "missing" }; });
  await assert.rejects(store.getControl("intents/private.json"), ControlTransportError);
  assert.equal(calls, 0);
  await assert.rejects(store.getControl(path), (error: unknown) => error instanceof ControlTransportError && error.outcome === "uncertain");
  const invoke = createStdioS3Invoker({ executable: "/does-not-exist", workspace, bucket: "mock-bucket", region: "us-east-1", enabled: true });
  await assert.rejects(invoke({ version: 1, workspace: "other/prospectus", operation: "get", path }), (error: unknown) => error instanceof ControlTransportError && error.outcome === "unauthorized");
});

test("private stdio bridge preserves chunked Unicode and treats lost responses as uncertain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-s3-service-mock-"));
  const executable = join(directory, "mock-service");
  const body = '{"message":"世界 ☀"}';
  const source = `#!${process.execPath}\nlet input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const request=JSON.parse(input);const value=Buffer.from(JSON.stringify({version:1,workspace:process.env.PROSPECTUS_CONTROL_WORKSPACE,path:request.path,status:'ok',object:{bytes:${JSON.stringify(body)},revision:'"etag"'}}));const split=value.indexOf(Buffer.from('世'))+1;process.stdout.write(value.subarray(0,split));setTimeout(()=>process.stdout.end(value.subarray(split)),5);});\n`;
  await writeFile(executable, source, { mode: 0o700 });
  try {
    const invoke = createStdioS3Invoker({ executable, workspace, bucket: "mock-bucket", region: "us-east-1", enabled: true });
    const store = new VirtuusS3ControlStore(workspace, invoke);
    assert.equal((await store.getControl(path))!.bytes, body);
    await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.exit(0));\n`);
    await assert.rejects(store.putControl(path, "claim", { absent: true }), (error: unknown) => error instanceof ControlTransportError && error.outcome === "uncertain");
    await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();setTimeout(()=>{},1000);\n`);
    const timeout = new VirtuusS3ControlStore(workspace, createStdioS3Invoker({ executable, workspace, bucket: "mock-bucket", region: "us-east-1", enabled: true, timeoutMs: 50 }));
    await assert.rejects(timeout.putControl(path, "claim", { absent: true }), (error: unknown) => error instanceof ControlTransportError && error.outcome === "uncertain");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
