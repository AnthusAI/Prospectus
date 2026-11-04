import type { Role, Person, AccountSummary } from "./client.js";
import type { OperatorQuotaView, QuotaView } from "./quota.js";
export interface DirectoryMembership {
  accountId: string;
  personId: string;
  role: Role;
  status: "active" | "revoked";
}
export interface DirectoryAccount {
  id: string;
  name: string;
  role: Role;
  products: Array<{ product: string; status: "active" | "disabled" }>;
}
export interface DirectoryList {
  person: Person | null;
  accounts: DirectoryAccount[];
  operatorAccess?: boolean;
}
export interface DirectoryCreator {
  create(name: string, requestKey: string): Promise<DirectoryAccount>;
}
export interface DirectoryDetail extends DirectoryAccount {
  createdAt: string;
  revision: number;
  entitlements: AccountSummary["entitlement"][];
  memberships: DirectoryMembership[];
  membershipsVisible: boolean;
  quota: QuotaView;
}
export interface DirectoryReader {
  list(): Promise<DirectoryList>;
  detail(id: string): Promise<DirectoryDetail>;
}

export interface OperatorAccount {
  id: string;
  name: string;
  createdAt: string;
  revision: number;
  products: DirectoryAccount["products"];
  activeMembers: number;
}
export interface OperatorList {
  person: Person;
  accounts: OperatorAccount[];
}
export interface OperatorDetail extends OperatorAccount {
  entitlements: AccountSummary["entitlement"][];
  memberships: DirectoryMembership[];
  quota: OperatorQuotaView;
}
export interface OperatorEntitlementWriter {
  /** Turn a registered product on (`active`) or off (`disabled`) for an account. Central refuses non-holders. */
  setEntitlement(accountId: string, product: string, status: "active" | "disabled"): Promise<void>;
}
export interface OperatorReader {
  operatorList(): Promise<OperatorList>;
  operatorDetail(id: string): Promise<OperatorDetail>;
}
