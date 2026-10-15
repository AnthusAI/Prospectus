import {test} from "node:test";
import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import {directoryFixture} from "./testing/directory-fixture";
import {canonicalAccountsHandler} from "./canonical-handler";
import {VirtuusIdentityFiles,VirtuusAccountFiles} from "./identity-files";
import {accountsBffHandler} from "./bff";
import {AccountsClient,decode} from "../packages/accounts-client/src/client";
test("canonical directory filters organizations by membership, never CRM admin or product alone",async()=>{
 const x=await directoryFixture();try {
  const request=(actor:typeof x.ownerDirectory,path:string)=>x.handler()(x.f.event(actor.index,path,{},actor.proof,"GET"));
  const listed=await request(x.ownerDirectory,"/v1/account-directory");assert.equal(listed.statusCode,200);assert.equal(JSON.parse(listed.body).accounts[0].id,x.account.id);assert.equal(JSON.parse(listed.body).accounts[0].products[0].product,"papyrus");
  assert.deepEqual(JSON.parse((await request(x.outsider,"/v1/account-directory")).body).accounts,[]);assert.equal((await request(x.outsider,`/v1/account-directory/${x.account.id}`)).statusCode,403);
  assert.equal((await request(x.owner,`/v1/account-directory/${x.account.id}`)).statusCode,403); // normal console runtime cannot use directory routes
  assert.equal((await request(x.ownerDirectory,`/v1/accounts/${x.account.id}`)).statusCode,403); // directory visibility grants no product entitlement
 }finally{await rm(x.root,{recursive:true,force:true});}
});
test("owner and admin see memberships; members and viewers see only themselves; restart and revocation persist",async()=>{
 const x=await directoryFixture();try{
  const detail=async(actor:typeof x.ownerDirectory)=>{const response=await x.handler()(x.f.event(actor.index,`/v1/account-directory/${x.account.id}`,{},actor.proof,"GET"));assert.equal(response.statusCode,200);return JSON.parse(response.body).account;};
  assert.equal((await detail(x.ownerDirectory)).memberships.length,2);
  for(const role of ["member","viewer","admin"] as const){await x.service.setMembership(x.owner.context,x.account.id,x.member.person.id,role,"active");const account=await detail(x.memberDirectory);assert.equal(account.membershipsVisible,role==="admin");assert.equal(account.memberships.length,role==="admin"?2:1);assert.equal(account.role,role);}
  const restarted=canonicalAccountsHandler(new VirtuusIdentityFiles(x.root),new VirtuusAccountFiles(x.root),x.products,x.f.keys,()=>x.f.now);assert.equal(JSON.parse((await restarted(x.f.event(0,`/v1/account-directory/${x.account.id}`,{},x.memberDirectory.proof,"GET"))).body).account.name,"Persisted Papyrus organization");
  await x.service.setMembership(x.owner.context,x.account.id,x.member.person.id,"admin","revoked");assert.equal((await restarted(x.f.event(0,`/v1/account-directory/${x.account.id}`,{},x.memberDirectory.proof,"GET"))).statusCode,403);
  const list=JSON.parse((await restarted(x.f.event(0,"/v1/account-directory",{},x.memberDirectory.proof,"GET"))).body);assert.deepEqual(list.accounts,[]);
 }finally{await rm(x.root,{recursive:true,force:true});}
});
test("JWT BFF returns actual persisted accounts and rejects browser authority or write paths",async()=>{
 const x=await directoryFixture();let forwarded=0;try {
  const bff=accountsBffHandler({origin:"https://prospectus.anth.us",registration:x.products[0],keys:x.f.keys,nowSeconds:()=>x.f.now,client:(access,id)=>new AccountsClient(async(path,method,body)=>{
   forwarded++;const event=x.f.event(0,path,body??{},x.ownerDirectory.proof,method);event.headers!["x-prospectus-human-token"]=access;if(id)event.headers!["x-prospectus-identity-token"]=id;const response=await x.handler()(event);return decode(new Response(response.body,{status:response.statusCode}));
  })});
  const event={rawPath:"/api/saas/accounts",requestContext:{http:{method:"GET"}},headers:{authorization:`Bearer ${x.ownerDirectory.proof.access}`}};
  const list=await bff(event);assert.equal(list.statusCode,200);assert.equal(JSON.parse(list.body).accounts[0].id,x.account.id);
  const detail=await bff({...event,rawPath:`/api/saas/accounts/${x.account.id}`});assert.equal(JSON.parse(detail.body).account.membershipsVisible,true);
  const before=forwarded;assert.equal((await bff({...event,headers:{}})).statusCode,401);assert.equal(forwarded,before);
  assert.equal((await bff({...event,rawPath:"/api/saas/identity/challenge",requestContext:{http:{method:"POST"}},headers:{...event.headers,origin:"https://wrong.invalid"}})).statusCode,403);
  assert.equal((await bff({...event,requestContext:{http:{method:"POST"}},headers:{...event.headers,origin:"https://prospectus.anth.us"}})).statusCode,404);
  assert.equal((await bff({...event,rawPath:"/api/saas/identity/challenge",requestContext:{http:{method:"POST"}},headers:{...event.headers,origin:"https://prospectus.anth.us","content-type":"application/json"},body:JSON.stringify({roleArn:"forged"})})).statusCode,400);
 }finally{await rm(x.root,{recursive:true,force:true});}
});
test("BFF fresh Google confirmation requires independent signed ID evidence and frozen challenge",async()=>{
 const x=await directoryFixture();try{
  const bff=accountsBffHandler({origin:"https://prospectus.anth.us",registration:x.products[0],keys:x.f.keys,nowSeconds:()=>x.f.now,client:(access,id)=>new AccountsClient(async(path,method,body)=>{
   const event=x.f.event(0,path,body??{},x.ownerDirectory.proof,method);event.headers!["x-prospectus-human-token"]=access;if(id)event.headers!["x-prospectus-identity-token"]=id;const response=await x.handler()(event);return decode(new Response(response.body,{status:response.statusCode}));
  })});
  const event={rawPath:"/api/saas/identity/challenge",requestContext:{http:{method:"POST"}},headers:{authorization:`Bearer ${x.ownerDirectory.proof.access}`,origin:"https://prospectus.anth.us","content-type":"application/json"},body:"{}"};
  const challengeResponse=await bff(event);assert.equal(challengeResponse.statusCode,200);const challenge=JSON.parse(challengeResponse.body);
  const fresh=x.f.pair(0,challenge.nonce,"synthetic-google-owner",{sub:"synthetic-owner-0"},{sub:"synthetic-owner-0"});
  const resolve={...event,rawPath:"/api/saas/identity/resolve",headers:{...event.headers,authorization:`Bearer ${fresh.access}`},body:JSON.stringify({challengeId:challenge.challengeId,idToken:fresh.id})};
  const confirmed=await bff(resolve);assert.equal(confirmed.statusCode,200);assert.equal(JSON.parse(confirmed.body).person.id,x.owner.person.id);
  assert.equal((await bff({...resolve,body:JSON.stringify({challengeId:challenge.challengeId,idToken:"forged"})})).statusCode,401);
 }finally{await rm(x.root,{recursive:true,force:true});}
});
