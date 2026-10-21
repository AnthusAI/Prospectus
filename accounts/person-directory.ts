import type { Context, Person } from "./model";
import type { ValidatedRegistrations } from "./registration";
import { isGoogleDirect } from "./google-direct";
import { enrollmentBinding, sameBinding, type GoogleIdentityRepository } from "./google-identity";
export interface PersonDirectory {
  resolve(context: Context): Promise<Person | null>;
  get(id: string): Promise<Person | null>;
}
/** Context must originate from the verified central transport, never request JSON. */
export function googlePersonDirectory(
  repository: GoogleIdentityRepository,
  products: ValidatedRegistrations,
): PersonDirectory {
  return {
    get: (id) => repository.getPerson(id),
    resolve: async (context) => {
      const session = context.human.session;
      const product = products.find(
        (item) =>
          item.enabled &&
          item.product === context.product &&
          (item.roleArn === context.principal || item.executionDelegation?.roleArn === context.principal) &&
          item.issuer === context.human.issuer &&
          item.googleFederation?.clientId === session?.clientId,
      );
      if (!product?.googleFederation || !session) return null;
      const binding = enrollmentBinding(product, context.principal);
      const identity = await repository.find(context.human.issuer, context.human.subject, {
        binding,
        authTime: session.authTime,
        lineageHash: session.lineageHash,
      });
      // A Google-direct caller presents a fresh Google ID token on every request, so there is no single enrolled
      // login to match. Enrollment under this exact product binding is the evidence instead.
      if (isGoogleDirect(product))
        return identity?.alias.provenance.some((prior) => sameBinding(prior, binding))
          ? identity.person
          : null;
      if (
        !identity?.alias.sessions.some(
          (known) =>
            sameBinding(known.binding, binding) &&
            known.authTime === session.authTime &&
            known.lineageHash === session.lineageHash,
        )
      )
        return null;
      return identity.person;
    },
  };
}
