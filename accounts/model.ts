import type { Role, Operation, Person, AccountSummary } from "../packages/accounts-client/src/client";
export type { Role, Operation, Person, AccountSummary } from "../packages/accounts-client/src/client";
export interface Membership {
  accountId: string;
  personId: string;
  role: Role;
  status: "active" | "revoked";
}
export type Entitlement = AccountSummary["entitlement"];
export interface AccountAuthorization {
  allowed: true;
  accountId: string;
  personId: string;
  product: string;
  role: Role;
  operation: Operation;
  revision: number;
}
export interface Human {
  issuer: string;
  subject: string;
  session?: { clientId: string; authTime: number; lineageHash: string };
}
export interface Context {
  product: string;
  principal: string;
  human: Human;
  capabilities: readonly Operation[];
}
export class AccountsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new AccountsError(status, code, message);
}
export const roleOperations: Record<Role, readonly Operation[]> = {
  owner: ["console:read", "console:write", "members:read", "members:write"],
  admin: ["console:read", "console:write", "members:read", "members:write"],
  member: ["console:read", "console:write"],
  viewer: ["console:read"],
};

export const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
