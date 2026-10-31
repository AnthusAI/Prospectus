import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { KANBUS_API_PATH } from "../../src/board";

/**
 * AGENTS.md: canonical data stays ordinary Kanbus files with unchanged paths and bytes.
 * Synthetic fixtures are in the API's own pretty JSON form. Reads must leave every byte alone, and
 * an edit may change only the keys it targets (plus updated_at): key order, number text, escapes,
 * unknown top-level keys and the trailing newline must survive. The same scenarios were run against
 * the previous Kanbus pin (2541091) and the byte results were identical (kanbus-0ec206).
 */
const fixtures = join("test", "fixtures", "canonical-bytes", "issues");

/** Split pretty JSON into its top-level `"key": ...` segments, preserving key order. */
function segments(text: string): { order: string[]; byKey: Map<string, string> } {
  const order: string[] = [];
  const byKey = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    const key = /^ {2}"([^"]+)":/.exec(line)?.[1];
    if (key !== undefined) {
      order.push(key);
      current = [line];
      byKey.set(key, current);
    } else current?.push(line);
  }
  return { order, byKey: new Map([...byKey].map(([key, lines]) => [key, lines.join("\n")])) };
}

function changedKeys(before: string, after: string): string[] {
  const left = segments(before);
  const right = segments(after);
  assert.deepEqual(right.order, left.order, "top-level key order must not change");
  assert.ok(after.endsWith("}\n") && !after.endsWith("\n\n"), "exactly one trailing newline");
  return left.order.filter((key) => left.byKey.get(key) !== right.byKey.get(key)).sort();
}

test("reads leave canonical issue bytes untouched and edits change only the targeted keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-bytes-"));
  const root = join(directory, "kanbus");
  await mkdir(join(root, "project/issues"), { recursive: true });
  await mkdir(join(root, "project/events"), { recursive: true });
  await copyFile("config/prospectus.kanbus.yml", join(root, ".kanbus.yml"));
  const names = (await readdir(fixtures)).filter((name) => name.endsWith(".json")).sort();
  assert.equal(names.length, 4);
  const originals = new Map<string, string>();
  for (const name of names) {
    await copyFile(join(fixtures, name), join(root, "project/issues", name));
    originals.set(name, await readFile(join(fixtures, name), "utf8"));
  }
  const token = randomBytes(32).toString("hex");
  const child = spawn(
    resolve(process.env.KANBUS_API_BINARY ?? ".build/target/release/kanbus-api-local"),
    [],
    {
      env: {
        ...process.env,
        KANBUS_BACKEND: "file",
        KANBUS_ROOT: root,
        KANBUS_TENANT: "cyclotron",
        KANBUS_PROJECT: "prospectus",
        KANBUS_PORT: "0",
        KANBUS_LOCAL_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  try {
    let output = "";
    const origin = await new Promise<string>((resolveOrigin, reject) => {
      const timeout = setTimeout(() => reject(new Error("Real Kanbus API did not start")), 30000);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Real Kanbus API exited before readiness")));
      child.stderr.on("data", (data: Buffer) => {
        output += data.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timeout);
          resolveOrigin(match[0]);
        }
      });
    });
    const call = async (method: string, path: string, body?: unknown, revision?: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (revision) headers["If-Match"] = revision;
      if (method !== "GET") headers["X-Operation-Id"] = randomUUID();
      const response = await fetch(`${origin}${KANBUS_API_PATH}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const onDisk = (name: string) => readFile(join(root, "project/issues", name), "utf8");

    // (a) Reads, including the board query, change nothing.
    assert.equal((await call("GET", "/issues")).status, 200);
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      assert.equal((await call("GET", `/issues/${id}`)).status, 200);
      assert.equal(await onDisk(name), originals.get(name), `${name} unchanged by reads`);
    }

    // (b) Edits touch only their own keys.
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      const original = originals.get(name)!;
      let { body } = await call("GET", `/issues/${id}`);
      const title = body.issue.title as string;
      const edit = async (path: string, method: string, change: unknown) => {
        const before = await onDisk(name);
        const result = await call(method, path, change, body.revision);
        assert.ok(result.status < 300, `${name} ${JSON.stringify(change)} -> ${result.status}`);
        body = result.body;
        return { before, after: await onDisk(name) };
      };

      let step = await edit(`/issues/${id}`, "PATCH", { title: "Edited title" });
      assert.deepEqual(changedKeys(step.before, step.after), ["title", "updated_at"]);

      step = await edit(`/issues/${id}`, "PATCH", { title });
      assert.deepEqual(changedKeys(original, step.after), ["updated_at"], "revert restores every other byte");

      step = await edit(`/issues/${id}`, "PATCH", { custom: { next_action: "Call back" } });
      assert.deepEqual(changedKeys(step.before, step.after), ["custom", "updated_at"]);

      step = await edit(`/issues/${id}/comments`, "POST", { text: "A note" });
      assert.deepEqual(changedKeys(step.before, step.after), ["comments", "updated_at"]);

      const closed = body.issue.status === "lost";
      step = await edit(`/issues/${id}`, "PATCH", { status: closed ? "new" : "contacted" });
      assert.deepEqual(
        changedKeys(step.before, step.after),
        ["closed_at", "status", "updated_at"].filter((key) => key !== "closed_at" || closed),
      );

      // Values the API did not touch keep their exact text.
      const final = await onDisk(name);
      for (const key of ["id", "created_at", "creator", "type", "parent", "labels", "dependencies"]) {
        assert.equal(segments(final).byKey.get(key), segments(original).byKey.get(key), `${name} ${key}`);
      }
    }

    // Number text, escapes and unknown keys survive a rewrite verbatim.
    const rewritten = await onDisk(names[1]);
    for (const text of ["2.50", "12345678901234567890123", "-0.0", "1.5e-7", "\\u0007", "\\\\ back"]) {
      assert.ok(rewritten.includes(text), `${text} preserved`);
    }
    assert.ok((await onDisk(names[2])).includes('"written_by_newer_cli": {\n    "nested": [\n      1,'));
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
