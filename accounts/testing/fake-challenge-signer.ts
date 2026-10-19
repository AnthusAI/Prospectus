import { createHmac } from "node:crypto";
import type { ChallengeMacSigner } from "../challenge-token";

/** Test double for the KMS HMAC key. It counts calls and can be made to fail like a KMS outage. */
export class FakeChallengeMacSigner implements ChallengeMacSigner {
  generated = 0;
  verified = 0;
  unavailable = false;
  constructor(private key = "synthetic-challenge-mac-key") {}
  async generate(message: Uint8Array) {
    if (this.unavailable) throw new Error("KMS unavailable");
    this.generated++;
    return createHmac("sha256", this.key).update(message).digest();
  }
  async verify(message: Uint8Array, mac: Uint8Array) {
    if (this.unavailable) throw new Error("KMS unavailable");
    this.verified++;
    const expected = createHmac("sha256", this.key).update(message).digest();
    return expected.length === mac.length && expected.equals(Buffer.from(mac));
  }
}
