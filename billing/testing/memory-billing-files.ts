import { IdentityFileError, type IdentityFiles, type IdentityObject } from "../../accounts/identity-files";

type Outcome = { value: any; revision: string } | "conflict";

/**
 * In-memory IdentityFiles with the Virtuus commit semantics billing relies on. An operation ID is frozen with its
 * request hash at first use: the same ID and hash answer with the original outcome (the stored result, or a
 * conflict) and never write again; the same ID with another hash is operation_mismatch. A new operation must name
 * the current revision, or null for an absent path, or it records a conflict. Synthetic tests only.
 */
export class MemoryBillingFiles implements IdentityFiles {
  objects = new Map<string, { value: any; revision: string }>();
  operations = new Map<string, { requestHash: string; outcome: Outcome }>();
  commits: string[] = [];
  /** Runs before a new operation is evaluated, to interleave a competing writer or a crash. */
  beforeCommit?: (path: string) => void | Promise<void>;
  private revisions = 0;
  async get<T = any>(path: string): Promise<IdentityObject<T> | null> {
    const stored = this.objects.get(path);
    return stored ? { value: structuredClone(stored.value), revision: stored.revision } : null;
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((path) => path.startsWith(prefix)).sort();
  }
  async commit<T>(
    path: string,
    operationId: string,
    requestHash: string,
    value: T,
    revision: string | null,
  ): Promise<IdentityObject<T>> {
    const prior = this.operations.get(operationId);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new IdentityFileError("operation_mismatch");
      if (prior.outcome === "conflict") throw new IdentityFileError("conflict");
      return { value: structuredClone(prior.outcome.value), revision: prior.outcome.revision };
    }
    const hook = this.beforeCommit;
    if (hook) await hook(path);
    const stored = this.objects.get(path);
    if ((stored?.revision ?? null) !== revision) {
      this.operations.set(operationId, { requestHash, outcome: "conflict" });
      throw new IdentityFileError("conflict");
    }
    const next = { value: structuredClone(value), revision: `r${++this.revisions}` };
    this.objects.set(path, next);
    this.operations.set(operationId, { requestHash, outcome: structuredClone(next) });
    this.commits.push(path);
    return structuredClone(next) as IdentityObject<T>;
  }
}
