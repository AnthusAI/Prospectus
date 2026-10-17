import type { Context, Person } from "./model";
import type { ProductRegistration } from "./auth";
import { registrations } from "./registration";
import { enrollmentBinding, sameBinding, type GoogleIdentityRepository } from "./google-identity";
export interface PersonDirectory {
  resolve(context: Context): Promise<Person | null>;
  get(id: string): Promise<Person | null>;
}
/** Context must originate from the verified central transport, never request JSON. */
export function googlePersonDirectory(
  repository: GoogleIdentityRepository,
  products: readonly ProductRegistration[],
): PersonDirectory {
  const trusted = registrations(structuredClone(products));
  return {
    get: (id) => repository.getPerson(id),
    resolve: async (context) => {
      const session = context.human.session;
      const product = trusted.find(
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
