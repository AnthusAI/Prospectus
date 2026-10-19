import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VirtuusIdentityFiles, IdentityFileError } from "./identity-files";
const executable =
  process.env.PROSPECTUS_IDENTITY_TEST_BINARY ??
  resolve(".build/intake-control-target/debug/prospectus-identity-files");

test(
  "one request reuses its native process while every canonical read stays fresh",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "accounts-native-session-"));
    const marker = join(root, "starts"),
      wrapper = join(root, "native");
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await writeFile(wrapper, `#!/bin/sh\nprintf x >> ${quote(marker)}\nexec ${quote(executable)}\n`, {
      mode: 0o700,
    });
    const timings: unknown[] = [];
    const files = new VirtuusIdentityFiles(root, wrapper, undefined, true, (value) => timings.push(value));
    try {
      const first = await files.commit("people/a.json", "session-one", "a".repeat(64), { value: 1 }, null);
      assert.equal((await files.get<{ value: number }>("people/a.json"))?.value.value, 1);
      await files.commit("people/a.json", "session-two", "b".repeat(64), { value: 2 }, first.revision);
      assert.equal((await files.get<{ value: number }>("people/a.json"))?.value.value, 2);
      assert.deepEqual(await files.list("people/"), ["people/a.json"]);
      assert.equal(
        (await readFile(marker, "utf8")).length,
        1,
        "One native initialization per request namespace",
      );
      assert.equal(timings.filter((value: any) => value.phase === "initialize").length, 1);
      assert.ok(timings.some((value: any) => value.phase === "storage" && value.operation === "get_bounded"));
      for (const value of timings)
        assert.deepEqual(Object.keys(value as object).sort(), [
          "durationMs",
          "operation",
          "phase",
          "success",
        ]);
    } finally {
      files.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "separate requests reread canonical authority and closing forbids further work",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "accounts-native-isolation-"));
    const first = new VirtuusIdentityFiles(root, executable, undefined, true);
    const second = new VirtuusIdentityFiles(root, executable, undefined, true);
    try {
      const created = await first.commit(
        "people/a.json",
        "session-create",
        "c".repeat(64),
        { active: true },
        null,
      );
      assert.equal((await first.get<{ active: boolean }>("people/a.json"))?.value.active, true);
      await second.commit(
        "people/a.json",
        "session-revoke",
        "d".repeat(64),
        { active: false },
        created.revision,
      );
      assert.equal((await first.get<{ active: boolean }>("people/a.json"))?.value.active, false);
      await assert.rejects(
        first.commit("people/a.json", "session-stale", "e".repeat(64), { active: true }, created.revision),
        (error) => error instanceof IdentityFileError && error.code === "conflict",
      );
      assert.equal((await first.get<{ active: boolean }>("people/a.json"))?.value.active, false);
      first.close();
      await assert.rejects(
        first.get("people/a.json"),
        (error) => error instanceof IdentityFileError && error.code === "unavailable",
      );
    } finally {
      first.close();
      second.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const mode of ["malformed", "oversized", "eof", "closed"] as const)
  test(`request session fails closed on ${mode} native transport`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "accounts-native-failure-")),
      wrapper = join(root, "native");
    const response = {
      malformed: 'process.stdout.write("not-json\\n")',
      oversized: 'process.stdout.write("x".repeat(131074))',
      eof: "process.exit(0)",
      closed: "setTimeout(()=>{},10000)",
    }[mode];
    await writeFile(
      wrapper,
      `#!/usr/bin/env node\nrequire('node:readline').createInterface({input:process.stdin}).once('line',()=>{${response}});\n`,
      { mode: 0o700 },
    );
    const files = new VirtuusIdentityFiles(root, wrapper, undefined, true);
    try {
      const pending = files.get("people/a.json");
      const queued =
        mode === "closed"
          ? assert.rejects(
              files.get("people/b.json"),
              (error) => error instanceof IdentityFileError && error.code === "unavailable",
            )
          : undefined;
      if (mode === "closed") setTimeout(() => files.close(), 30);
      await assert.rejects(
        pending,
        (error) => error instanceof IdentityFileError && error.code === "uncertain",
      );
      await queued;
      await assert.rejects(
        files.get("people/a.json"),
        (error) => error instanceof IdentityFileError && error.code === "unavailable",
      );
    } finally {
      files.close();
      await rm(root, { recursive: true, force: true });
    }
  });
