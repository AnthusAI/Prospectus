import { hmacSha256 } from "../challenge-signer";
import type { SiteSubjectSecret } from "../site-subjects";

/** Test double for the v1 site subject secret. It counts uses and can be made unavailable like a missing parameter. */
export class FakeSiteSubjectSecret implements SiteSubjectSecret {
  macs = 0;
  unavailable = false;
  constructor(readonly key = Buffer.from("synthetic-site-subject-secret-0123456789abcdef")) {}
  async ready() {
    if (this.unavailable) throw new Error("site subject secret unavailable");
  }
  async mac(bytes: Uint8Array) {
    await this.ready();
    this.macs++;
    return hmacSha256(this.key, bytes);
  }
}
