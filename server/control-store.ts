import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export interface ControlObject {
  bytes: string;
  revision: string;
}
export type ControlCondition = { absent: true } | { revision: string };
export class ControlConflict extends Error {}

// Mirrors Virtuus ObjectStore's strongly consistent control get and conditional put.
// Production requires its scoped S3 get_control/put_control binding, not this file adapter.
export interface ConditionalControlStore {
  getControl(path: string): Promise<ControlObject | null>;
  putControl(path: string, bytes: string, condition: ControlCondition): Promise<ControlObject>;
}

export class FileControlStore implements ConditionalControlStore {
  constructor(private directory: string) {}
  private path(key: string) {
    if (!/^intake-(identities|receipts|newsletter)\/[a-f0-9]{64}\.json$/.test(key))
      throw new Error("Invalid intake control path.");
    const [prefix, name] = key.split("/");
    return join(
      this.directory,
      prefix === "intake-identities"
        ? name
        : prefix === "intake-receipts"
          ? `receipt-${name}`
          : `newsletter-${name}`,
    );
  }
  async getControl(key: string): Promise<ControlObject | null> {
    try {
      const file = await open(this.path(key), "r");
      try {
        if ((await file.stat()).size > 32768) throw new Error("Identity claim exceeds 32 KiB.");
        const bytes = await file.readFile("utf8");
        return { bytes, revision: createHash("sha256").update(bytes).digest("hex") };
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async putControl(key: string, bytes: string, condition: ControlCondition): Promise<ControlObject> {
    if (Buffer.byteLength(bytes) > 32768) throw new Error("Identity claim exceeds 32 KiB.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(key);
    const lock = `${path}.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ControlConflict(
          "Conditional control write is busy; inspect stale locks after stopping workers.",
        );
      throw error;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const current = await this.getControl(key);
      if ("absent" in condition ? current !== null : current?.revision !== condition.revision)
        throw new ControlConflict("Control revision changed.");
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { bytes, revision: createHash("sha256").update(bytes).digest("hex") };
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
