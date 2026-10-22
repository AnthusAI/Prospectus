import { IdentityFileError, type IdentityFiles, type IdentityObject } from "../identity-files";

/** In-memory IdentityFiles with the Virtuus create-only semantics: an identical retry returns the stored object and
 * any other write to an existing path is a conflict. Synthetic tests only. */
export class MemoryIdentityFiles implements IdentityFiles {
  objects = new Map<string, { value: any; revision: string; operationId: string; requestHash: string }>();
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
    const stored = this.objects.get(path);
    if (stored) {
      if (stored.operationId === operationId && stored.requestHash === requestHash)
        return { value: structuredClone(stored.value), revision: stored.revision };
      if (revision !== stored.revision) throw new IdentityFileError("conflict");
    } else if (revision !== null) throw new IdentityFileError("conflict");
    const next = {
      value: structuredClone(value),
      revision: `r${++this.revisions}`,
      operationId,
      requestHash,
    };
    this.objects.set(path, next);
    return { value: structuredClone(value), revision: next.revision };
  }
}
