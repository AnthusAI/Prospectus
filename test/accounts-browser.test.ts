import {test} from "node:test";
import assert from "node:assert/strict";
import {accountsBrowser,DirectoryError} from "../src/accounts-client";
test("accounts browser uses bearer BFF reads and preserves actual account response fields",async()=>{
 const account={id:"11111111-1111-4111-8111-111111111111",name:"Persisted organization",role:"viewer",products:[{product:"cyclotron",status:"active"}]};const calls:string[]=[];
 const client=accountsBrowser("https://bff.example.invalid/api/saas",async(input,init)=>{calls.push(String(input));assert.equal((init?.headers as any).authorization,"Bearer synthetic-token");assert.equal(init?.cache,"no-store");return new Response(JSON.stringify(calls.length===1?{person:{id:"p",createdAt:"2030-01-01"},accounts:[account]}:{account:{...account,entitlements:[],memberships:[],membershipsVisible:false,revision:3,createdAt:"2030-01-01"}}));},()=>"synthetic-token");
 assert.equal((await client.list()).accounts[0].name,account.name);assert.equal((await client.detail(account.id)).revision,3);assert.equal(calls.length,2);
});
test("unconfigured account service never invents accounts or attempts network",async()=>{let requested=false;const client=accountsBrowser(undefined,async()=>{requested=true;throw new Error();},()=>"synthetic");assert.equal(client.configured,false);await assert.rejects(client.list(),/not been configured/);assert.equal(requested,false);});
test("account authorization errors remain errors rather than empty success",async()=>{for(const status of [401,403,503]){const client=accountsBrowser("https://bff.invalid",async()=>new Response("{}",{status}),()=>"synthetic");await assert.rejects(client.list(),error=>error instanceof DirectoryError && error.status===status);}});
test("malformed successful account responses become errors",async()=>{const client=accountsBrowser("https://bff.invalid",async()=>new Response("{}"),()=>"synthetic");await assert.rejects(client.list(),/Invalid account response/);await assert.rejects(client.detail("11111111-1111-4111-8111-111111111111"),/Invalid account response/);});
