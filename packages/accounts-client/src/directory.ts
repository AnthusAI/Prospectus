import type {Role,Person,AccountSummary} from "./client";
export interface DirectoryMembership {accountId:string;personId:string;role:Role;status:"active"|"revoked"}
export interface DirectoryAccount {id:string;name:string;role:Role;products:Array<{product:string;status:"active"|"disabled"}>}
export interface DirectoryList {person:Person|null;accounts:DirectoryAccount[]}
export interface DirectoryDetail extends DirectoryAccount {createdAt:string;revision:number;entitlements:AccountSummary["entitlement"][];memberships:DirectoryMembership[];membershipsVisible:boolean}
export interface DirectoryReader {list():Promise<DirectoryList>;detail(id:string):Promise<DirectoryDetail>}
