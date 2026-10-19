import type { ChallengeSigner } from "../challenge-signer";
import { hmacSha256, macsAreEqual } from "../challenge-signer";

/** Test double with named keys. It counts calls and can be made to fail like an unreachable key service. */
export class FakeChallengeSigner implements ChallengeSigner {
  signed = 0;
  verified = 0;
  unavailable = false;
  constructor(
    public currentKeyId = "t1",
    private keys: Record<string, string> = { t1: "synthetic-challenge-mac-key-0123456789abcdef" },
  ) {}
  async sign(bytes: Uint8Array) {
    if (this.unavailable) throw new Error("signer unavailable");
    this.signed++;
    return hmacSha256(Buffer.from(this.keys[this.currentKeyId]), bytes);
  }
  async verify(keyId: string, bytes: Uint8Array, mac: Uint8Array) {
    if (this.unavailable) throw new Error("signer unavailable");
    this.verified++;
    const key = this.keys[keyId];
    return key !== undefined && macsAreEqual(hmacSha256(Buffer.from(key), bytes), mac);
  }
}
