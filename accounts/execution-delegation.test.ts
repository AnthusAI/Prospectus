import {test,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {canonicalAccountsHandler} from "./canonical-handler";
import {VirtuusIdentityFiles,VirtuusAccountFiles,IdentityFileError,type IdentityFiles} from "./identity-files";
import {DurableGoogleIdentities} from "./durable-google-identities";
import {registrations} from "./registration";
import {context,type ProductRegistration,type RestEvent} from "./auth";
import {googleFixture} from "./testing/google-fixture";
const roots:string[]=[];
after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});});
const worker="arn:aws:iam::111111111111:role/SyntheticWorker";
function paired(base:ProductRegistration[]):ProductRegistration[] {
 const products=structuredClone(base),p=products[0];p.capabilities=["console:read","console:write","members:read","members:write"];
 p.executionDelegation={roleArn:worker,enrollmentRoleArn:p.roleArn,issuer:p.issuer,clientId:p.googleFederation!.clientId,enrollmentPolicyRevision:p.googleFederation!.reviewedPolicyId,reviewedPolicyId:"synthetic-execution-review-v1"};
 return registrations(products);
}
async function fixture() {
 const f=googleFixture(),products=paired(f.products),root=await mkdtemp(join(tmpdir(),"prospectus-delegation-"));roots.push(root);
 const identities=new VirtuusIdentityFiles(root),accounts=new VirtuusAccountFiles(root);
 const make=(registry=products,identityFiles:IdentityFiles=identities,accountFiles:IdentityFiles=accounts)=>canonicalAccountsHandler(identityFiles,accountFiles,registry,f.keys,()=>f.now);
 const handler=make();
 const run=async(event:RestEvent,target=handler)=>{const result=await target(event);return {status:result.statusCode,body:JSON.parse(result.body)};};
 const challenge=(await run(f.event(0,"/v1/identities/google/challenge"))).body;
 const proof=f.pair(0,challenge.nonce),enrolled=await run(f.event(0,"/v1/identities/google/resolve",{challengeId:challenge.challengeId},proof));assert.equal(enrolled.status,200);
 const create=f.event(0,"/v1/accounts",{name:"Synthetic execution account"},proof);create.headers!["idempotency-key"]=randomUUID();
 const created=await run(create);assert.equal(created.status,200);const id=created.body.account.id as string;
 const event=(path="/v1/identities/me",method="GET",body:unknown={},token=proof)=>{
  const e=f.event(0,path,body,token,method);e.requestContext!.identity!.userArn="arn:aws:sts::111111111111:assumed-role/SyntheticWorker/synthetic-session";
  // Execution needs only access evidence, never the callback ID proof.
  delete e.headers!["x-prospectus-identity-token"];return e;
 };
 return {f,products,identities,accounts,make,handler,run,proof,person:enrolled.body.person,id,event,authorize:(operation="console:read")=>event(`/v1/accounts/${id}/authorize`,"POST",{operation})};
}
test("paired execution survives canonical restart without changing original provenance",async()=>{
 const x=await fixture(),repo=new DurableGoogleIdentities(x.identities),before=await repo.find(x.products[0].issuer,"synthetic-pool-person-0");
 assert.equal((await x.run(x.event())).body.person.id,x.person.id);
 const result=await x.run(x.authorize("console:write"),x.make());assert.equal(result.status,200);
 assert.deepEqual(result.body,{allowed:true,accountId:x.id,personId:x.person.id,product:"cyclotron",role:"owner",operation:"console:write",revision:1});
 const verified=await context(x.authorize(),x.products,x.f.keys,x.f.now);assert.equal(verified.principal,worker);
 assert.deepEqual(verified.capabilities,["console:read","console:write"]);
 assert.deepEqual(await new DurableGoogleIdentities(x.identities).find(x.products[0].issuer,"synthetic-pool-person-0"),before);
 assert.equal(before!.alias.sessions[0].binding.principal,x.products[0].roleArn);
 assert.ok(!before!.alias.provenance.some(binding=>binding.principal===worker));
});
test("production composition fractional wall clock emits integer challenge expiry",async t=>{
 const x=await fixture(),now=x.f.now+0.625;
 t.mock.method(Date,"now",()=>now*1000);
 // Omit the fixture clock: exercise the production factory's actual default,
 // which passes fractional seconds into the identity handler.
 const production=canonicalAccountsHandler(x.identities,x.accounts,x.products,x.f.keys);
 const issued=await x.run(x.f.event(0,"/v1/identities/google/challenge"),production);
 assert.equal(issued.status,200);const challenge=issued.body;
 assert.ok(Number.isSafeInteger(challenge.expiresAt));
 assert.equal(challenge.expiresAt,Math.floor(now)+300);
 assert.ok(now<challenge.expiresAt && challenge.expiresAt<=now+300);
 const stored=(await x.identities.get(`logins/${challenge.challengeId}.json`))!;
 assert.equal(stored.value.challenge.issuedAt,Math.floor(now));
 assert.equal(stored.value.challenge.expiresAt,challenge.expiresAt);
 const proof=x.f.pair(0,challenge.nonce);
 const resolved=await x.run(x.f.event(0,"/v1/identities/google/resolve",{challengeId:challenge.challengeId},proof),production);
 assert.equal(resolved.status,200);assert.equal(resolved.body.person.id,x.person.id);
});
test("worker route/method/operation negative matrix denies before canonical writes",async t=>{
 const x=await fixture(),before=await x.accounts.get(`accounts/${x.id}.json`);let writes=0;
 const observe=(files:IdentityFiles):IdentityFiles=>({get:path=>files.get(path),list:prefix=>files.list(prefix),commit:async(...args)=>{writes++;return files.commit(...args);}});
 const target=x.make(x.products,observe(x.identities),observe(x.accounts));
 const paths:Array<[string,string,unknown]>=[
  ["/v1/identities/google/challenge","POST",{}],["/v1/identities/google/resolve","POST",{challengeId:randomUUID()}],
  ["/v1/identities/resolve","POST",{}],["/v1/identities/link","POST",{}],
  ["/v1/accounts","GET",{}],["/v1/accounts","POST",{name:"Denied"}],[`/v1/accounts/${x.id}`,"GET",{}],
  [`/v1/accounts/${x.id}/memberships`,"POST",{personId:x.person.id,role:"owner",status:"active"}],
  ["/v1/account-directory","GET",{}],[`/v1/account-directory/${x.id}`,"GET",{}],
  ["/v1/identities/me","POST",{}],["/v1/identities/me/","GET",{}],
  [`/v1/accounts/${x.id}/authorize`,"GET",{}],[`/v1/accounts/${x.id}/authorize/extra`,"POST",{}],
  [`/v1/accounts/${"a".repeat(36)}/authorize`,"POST",{operation:"console:read"}],
 ];
 for(const [path,method,body] of paths)await t.test(`${method} ${path}`,async()=>assert.equal((await x.run(x.event(path,method,body),target)).status,403));
 for(const operation of ["members:read","members:write"])await t.test(operation,async()=>assert.equal((await x.run(x.authorize(operation),target)).status,403));
 assert.deepEqual(await x.accounts.get(`accounts/${x.id}.json`),before);assert.equal(writes,0);
});
test("unlisted, disabled and removed pairs fail closed on the next request",async t=>{
 const x=await fixture();
 const variants:Array<[string,(p:ProductRegistration[])=>void]>=[
  ["removed",p=>delete p[0].executionDelegation],["disabled",p=>p[0].enabled=false],
  ["different worker",p=>p[0].executionDelegation!.roleArn="arn:aws:iam::111111111111:role/SyntheticOtherWorker"],
  ["changed policy",p=>{p[0].googleFederation!.reviewedPolicyId="synthetic-review-v2";p[0].executionDelegation!.enrollmentPolicyRevision="synthetic-review-v2";}],
  ["different product",p=>p[0].product="other-product"],
  ["different enrolling principal",p=>{p[0].roleArn="arn:aws:iam::111111111111:role/SyntheticNewBff";p[0].executionDelegation!.enrollmentRoleArn=p[0].roleArn;}],
  ["different registered client",p=>{p[0].clientIds=["newclient"];p[0].googleFederation!.clientId="newclient";p[0].executionDelegation!.clientId="newclient";}],
  ["different registered issuer",p=>{p[0].issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticNew";p[0].executionDelegation!.issuer=p[0].issuer;}],
 ];
 for(const [name,change] of variants)await t.test(name,async()=>{
  const p=structuredClone(x.products);change(p);const handler=x.make(p);
  for(const event of [x.event(),x.authorize()]){const result=await x.run(event,handler);assert.ok(result.status>=400 || result.body.person===null);assert.notEqual(result.body.allowed,true);}
 });
 for(const [name,arn,accountId] of [["unknown","arn:aws:sts::111111111111:assumed-role/Unknown/s","111111111111"],["cross-account","arn:aws:sts::222222222222:assumed-role/SyntheticWorker/s","222222222222"],["static IAM","arn:aws:iam::111111111111:role/SyntheticWorker","111111111111"]])await t.test(name,async()=>{
  const e=x.event();e.requestContext!.identity={userArn:arn,accountId};assert.equal((await x.run(e)).status,403);
 });
 const readonly=structuredClone(x.products);readonly[0].capabilities=["console:read"];
 assert.equal((await x.run(x.authorize("console:write"),x.make(readonly))).status,403);
 assert.equal((await x.run(x.authorize(),x.make(readonly))).status,200);
 assert.equal((await x.run(x.event(`/v1/accounts/${x.id}/authorize`,"POST",{operation:"console:write",principal:x.products[0].roleArn}))).status,400);
});
test("cross-product/client/issuer, session family and invalid access never authorize",async t=>{
 const x=await fixture();
 const cases:Array<[string,ReturnType<typeof x.f.pair>]>=[
  ["cross product issuer",x.f.pair(1,"irrelevant")],
  ["wrong client",x.f.pair(0,"irrelevant","synthetic-google-a",{client_id:"outside"})],
  ["wrong issuer",x.f.pair(0,"irrelevant","synthetic-google-a",{iss:"https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Outside"})],
  ["unknown subject",x.f.pair(0,"irrelevant","synthetic-google-a",{sub:"unknown"})],
  ["new family",x.f.pair(0,"irrelevant","synthetic-google-a",{origin_jti:"new-family"})],
  ["changed auth time",x.f.pair(0,"irrelevant","synthetic-google-a",{auth_time:x.f.now-1})],
  ["missing family",x.f.pair(0,"irrelevant","synthetic-google-a",{origin_jti:null})],
  ["expired",x.f.pair(0,"irrelevant","synthetic-google-a",{exp:x.f.now})],
 ];
 const forged={...x.proof,access:x.proof.access.slice(0,x.proof.access.lastIndexOf(".")+1)+Buffer.alloc(256).toString("base64url")};cases.push(["forged",forged]);
 for(const [name,proof] of cases)await t.test(name,async()=>{
  const me=await x.run(x.event("/v1/identities/me","GET",{},proof));assert.ok(me.status>=400 || me.body.person===null);
  assert.ok((await x.run(x.event(`/v1/accounts/${x.id}/authorize`,"POST",{operation:"console:write"},proof))).status>=400);
 });
 // Continuation accepts a renewed JWT only within the originally enrolled family.
 x.f.advance(30);const renewed=x.f.pair(0,"unused","synthetic-google-a",{auth_time:x.f.now-30});
 assert.equal((await x.run(x.event("/v1/identities/me","GET",{},renewed))).body.person.id,x.person.id);
});
test("worker authorization reads current canonical role, revocation and entitlement",async()=>{
 const x=await fixture(),location=`accounts/${x.id}.json`;
 for(const [role,status,entitlement,read,write] of [["viewer","active","active",200,403],["member","active","active",200,200],["member","revoked","active",403,403],["owner","active","disabled",403,403]] as const) {
  const stored=(await x.accounts.get(location))!,document=structuredClone(stored.value);
  // Synthetic canonical external administration; retain a different active owner.
  const other=randomUUID();document.memberships[other]={accountId:x.id,personId:other,role:"owner",status:"active"};
  document.memberships[x.person.id]={accountId:x.id,personId:x.person.id,role,status};document.entitlements.cyclotron.status=entitlement;
  await x.accounts.commit(location,randomUUID(),"a".repeat(64),document,stored.revision);
  assert.equal((await x.run(x.authorize(),x.make())).status,read);assert.equal((await x.run(x.authorize("console:write"),x.make())).status,write);
 }
 assert.equal((await x.run(x.event())).status,200); // Identity alone never grants account access.
 assert.equal((await x.run(x.event(`/v1/accounts/${randomUUID()}/authorize`,"POST",{operation:"console:read"}))).status,403);
});
test("missing or unavailable canonical persistence cannot grant execution",async()=>{
 const x=await fixture(),down:IdentityFiles={get:async()=>{throw new IdentityFileError("unavailable");},list:async()=>{throw new IdentityFileError("unavailable");},commit:async()=>{throw new IdentityFileError("unavailable");}};
 assert.equal((await x.run(x.event(),x.make(x.products,down))).status,503);
 assert.equal((await x.run(x.authorize(),x.make(x.products,x.identities,down))).status,503);
});
test("a different enrolled Person and another product account cannot inherit access",async()=>{
 const x=await fixture();
 const c=(await x.run(x.f.event(0,"/v1/identities/google/challenge"))).body;
 const other=x.f.pair(0,c.nonce,"synthetic-google-other",{sub:"synthetic-other-person"},{sub:"synthetic-other-person"});
 assert.equal((await x.run(x.f.event(0,"/v1/identities/google/resolve",{challengeId:c.challengeId},other))).status,200);
 const me=await x.run(x.event("/v1/identities/me","GET",{},other));assert.equal(me.status,200);assert.notEqual(me.body.person.id,x.person.id);
 assert.equal((await x.run(x.event(`/v1/accounts/${x.id}/authorize`,"POST",{operation:"console:read"},other))).status,403);
 const p1=(await x.run(x.f.event(1,"/v1/identities/google/challenge"))).body,proof=x.f.pair(1,p1.nonce);
 assert.equal((await x.run(x.f.event(1,"/v1/identities/google/resolve",{challengeId:p1.challengeId},proof))).body.person.id,x.person.id);
 const create=x.f.event(1,"/v1/accounts",{name:"Other product"},proof);create.headers!["idempotency-key"]=randomUUID();
 const account=(await x.run(create)).body.account;
 assert.equal((await x.run(x.event(`/v1/accounts/${account.id}/authorize`,"POST",{operation:"console:read"}))).status,403);
});
test("registry rejects ambiguous/transitive/unreviewed or mismatched pairs",async t=>{
 const base=paired(googleFixture().products);
 const changes:Array<[string,(p:ProductRegistration[])=>void]>=[
  ["self",p=>p[0].executionDelegation!.roleArn=p[0].roleArn],
  ["other product enrolling role",p=>p[0].executionDelegation!.roleArn=p[1].roleArn],
  ["STS path collision",p=>p[0].executionDelegation!.roleArn=p[0].roleArn.replace("role/","role/path/")],
  ["duplicate product",p=>p[1].product=p[0].product],
  ["enrollment principal mismatch",p=>p[0].executionDelegation!.enrollmentRoleArn=p[1].roleArn],
  ["issuer mismatch",p=>p[0].executionDelegation!.issuer=p[1].issuer],
  ["client mismatch",p=>p[0].executionDelegation!.clientId=p[1].clientIds[0]],
  ["policy mismatch",p=>p[0].executionDelegation!.enrollmentPolicyRevision="other-review"],
  ["review absent",p=>p[0].executionDelegation!.reviewedPolicyId=""],
  ["no federation",p=>delete p[0].googleFederation],
  ["directory principal",p=>p[0].accountDirectory=true],
  ["extra authority",p=>(p[0].executionDelegation as any).allowEnrollment=true],
  ["transitive",p=>{p[1].executionDelegation={...p[0].executionDelegation!,roleArn:p[0].roleArn,enrollmentRoleArn:p[1].roleArn,issuer:p[1].issuer,clientId:p[1].googleFederation!.clientId};}],
 ];
 for(const [name,change] of changes)await t.test(name,()=>{const p=structuredClone(base);change(p);assert.throws(()=>registrations(p));});
 assert.equal(registrations(base).length,2);
});
