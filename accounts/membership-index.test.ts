import {test,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DurableAccountsService,membershipLookupMode,type MembershipLookup} from "./durable-accounts";
import {VirtuusAccountFiles,VirtuusIdentityFiles,type IdentityFiles} from "./identity-files";
import {type Context,type Person,roleOperations} from "./model";
import {directoryFixture} from "./testing/directory-fixture";
import {canonicalAccountsHandler} from "./canonical-handler";
const roots:string[]=[];after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});});
const at="2030-03-17T17:46:40.000Z";
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"prospectus-membership-index-"));roots.push(root);
 const people:Record<string,Person>=Object.fromEntries(["alice","bob","carol"].map(subject=>[subject,{id:randomUUID(),createdAt:at}]));
 const contexts=Object.fromEntries(Object.keys(people).map(subject=>[subject,{product:"cyclotron",principal:"synthetic-runtime",human:{issuer:"synthetic",subject},capabilities:[...roleOperations.owner]} as Context]));
 const directory={resolve:async(context:Context)=>people[context.human.subject]??null,get:async(id:string)=>Object.values(people).find(person=>person.id===id)??null};
 const files=new VirtuusAccountFiles(root);
 const service=(membershipLookup:MembershipLookup,storage:IdentityFiles=files)=>new DurableAccountsService(storage,directory,()=>at,membershipLookup);
 return {root,people,contexts,files,service};
}
function recordingFiles(inner:IdentityFiles,extraAccountPaths:string[]=[]) {
 const listedPrefixes:string[]=[],readPaths:string[]=[];
 const files:IdentityFiles={
  get:async path=>{readPaths.push(path);return inner.get(path);},
  list:async prefix=>{listedPrefixes.push(prefix);return [...await inner.list(prefix),...(prefix==="accounts/"?extraAccountPaths:[])];},
  commit:inner.commit.bind(inner),
 };
 return {files,listedPrefixes,readPaths};
}

test("indexed lookup reads only the person's own accounts, even past the full-scan budget",async()=>{
 const x=await fixture(),indexed=x.service("indexed");
 const bobOwn=await indexed.create(x.contexts.bob,"Bob own",randomUUID()),shared=await indexed.create(x.contexts.alice,"Shared",randomUUID());
 for(let index=0;index<5;index++)await indexed.create(x.contexts.alice,`Alice only ${index}`,randomUUID());
 await indexed.setMembership(x.contexts.alice,shared.id,x.people.bob.id,"viewer","active");
 const unrelatedAccountPaths=Array.from({length:300},()=>`accounts/${randomUUID()}.json`);
 const recorded=recordingFiles(x.files,unrelatedAccountPaths);
 const listed=await x.service("indexed",recorded.files).list(x.contexts.bob);
 assert.deepEqual(listed.accounts.map(account=>account.id).sort(),[bobOwn.id,shared.id].sort());
 assert.deepEqual(recorded.listedPrefixes,[`members/${x.people.bob.id}/`]);
 assert.deepEqual(recorded.readPaths.sort(),[`accounts/${bobOwn.id}.json`,`accounts/${shared.id}.json`].sort());
 await assert.rejects(x.service("scan",recorded.files).list(x.contexts.bob),(error:any)=>error.code==="account_read_budget");
});

test("a revoked membership is not listed although its marker remains",async()=>{
 const x=await fixture(),indexed=x.service("indexed");
 const account=await indexed.create(x.contexts.alice,"Revocable",randomUUID());
 await indexed.setMembership(x.contexts.alice,account.id,x.people.bob.id,"member","active");
 assert.deepEqual((await indexed.list(x.contexts.bob)).accounts.map(listed=>listed.id),[account.id]);
 await indexed.setMembership(x.contexts.alice,account.id,x.people.bob.id,"member","revoked");
 assert.deepEqual(await x.files.list(`members/${x.people.bob.id}/`),[`members/${x.people.bob.id}/${account.id}.json`]);
 assert.deepEqual((await indexed.list(x.contexts.bob)).accounts,[]);
 await indexed.setMembership(x.contexts.alice,account.id,x.people.bob.id,"viewer","active");
 assert.equal((await indexed.list(x.contexts.bob)).accounts[0].role,"viewer");
});

test("a marker whose account never published is skipped",async()=>{
 const x=await fixture(),indexed=x.service("indexed"),accountId=randomUUID();
 await x.files.commit(`members/${x.people.carol.id}/${accountId}.json`,`membership-marker:${x.people.carol.id}:${accountId}`,"0".repeat(64),{version:1,kind:"membership-marker",personId:x.people.carol.id,accountId},null);
 assert.deepEqual((await indexed.list(x.contexts.carol)).accounts,[]);
});

test("rebuilding the index for accounts published before markers existed matches the full scan",async()=>{
 const x=await fixture();
 const filesWithoutMarkers:IdentityFiles={get:x.files.get.bind(x.files),list:x.files.list.bind(x.files),commit:async(path,operationId,requestHash,value,revision)=>path.startsWith("members/")?{value,revision:"skipped"}:x.files.commit(path,operationId,requestHash,value,revision)};
 const scan=x.service("scan",filesWithoutMarkers);
 const first=await scan.create(x.contexts.alice,"First",randomUUID()),second=await scan.create(x.contexts.bob,"Second",randomUUID());
 await scan.setMembership(x.contexts.alice,first.id,x.people.carol.id,"admin","active");await scan.setMembership(x.contexts.bob,second.id,x.people.carol.id,"viewer","active");
 await scan.setMembership(x.contexts.alice,first.id,x.people.bob.id,"member","active");await scan.setMembership(x.contexts.alice,first.id,x.people.bob.id,"member","revoked");
 const indexed=x.service("indexed");
 assert.deepEqual((await indexed.list(x.contexts.carol)).accounts,[]);
 assert.deepEqual(await indexed.rebuildMembershipIndex(),{accounts:2,markers:4});
 assert.deepEqual(await indexed.rebuildMembershipIndex(),{accounts:2,markers:4});
 for(const subject of ["alice","bob","carol"])assert.deepEqual(await indexed.list(x.contexts[subject]),await scan.list(x.contexts[subject]));
});

test("the personal account directory reads through the index",async()=>{
 const x=await directoryFixture();try {
  await x.service.rebuildMembershipIndex();
  const recorded=recordingFiles(new VirtuusAccountFiles(x.root));
  const handler=canonicalAccountsHandler(new VirtuusIdentityFiles(x.root),recorded.files,x.products,x.f.keys,()=>x.f.now,[],"indexed");
  const response=await handler(x.f.event(x.memberDirectory.index,"/v1/account-directory",{},x.memberDirectory.proof,"GET"));
  assert.equal(response.statusCode,200);assert.deepEqual(JSON.parse(response.body).accounts.map((account:{id:string})=>account.id),[x.account.id]);
  assert.deepEqual(recorded.listedPrefixes,[`members/${x.member.person.id}/`]);
 }finally{await rm(x.root,{recursive:true,force:true});}
});

test("deployment lookup mode accepts only scan or indexed and defaults to scan",()=>{
 assert.equal(membershipLookupMode(undefined),"scan");assert.equal(membershipLookupMode("indexed"),"indexed");
 assert.throws(()=>membershipLookupMode("everything"));
});
