import {test,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DurableAccountsService,type AccountDocument} from "./durable-accounts";
import {VirtuusAccountFiles,VirtuusIdentityFiles} from "./identity-files";
import {type Context,type Person,roleOperations} from "./model";
import {directoryFixture} from "./testing/directory-fixture";
import {canonicalAccountsHandler} from "./canonical-handler";
import {operatorSubjectHash,operatorGrants,type OperatorPermission} from "./operator-policy";
import type {ProductRegistration} from "./auth";
const roots:string[]=[];after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});});
const at="2030-03-17T17:46:40.000Z";
const forbidden=(error:any)=>error.code==="forbidden";
async function serviceFixture() {
 const root=await mkdtemp(join(tmpdir(),"prospectus-product-entitlements-"));roots.push(root);
 const people:Record<string,Person>=Object.fromEntries(["owner","member","operator"].map(subject=>[subject,{id:randomUUID(),createdAt:at}]));
 const contextFor=(subject:string,product:string):Context=>({product,principal:"synthetic-runtime",human:{issuer:"synthetic",subject},capabilities:[...roleOperations.owner]});
 const directory={resolve:async(context:Context)=>people[context.human.subject]??null,get:async(id:string)=>Object.values(people).find(person=>person.id===id)??null};
 const files=new VirtuusAccountFiles(root),service=new DurableAccountsService(files,directory,()=>at);
 return {people,contextFor,files,service};
}

test("granting a product lets members use it and disabling it denies only that product",async()=>{
 const x=await serviceFixture(),cyclotronLab={product:"cyclotron",capabilities:["console:read","console:write"] as const};
 const account=await x.service.create(x.contextFor("owner","papyrus"),"Newsroom",randomUUID());
 await x.service.setMembership(x.contextFor("owner","papyrus"),account.id,x.people.member.id,"member","active");
 await assert.rejects(x.service.authorize(x.contextFor("member","cyclotron"),account.id,"console:read"),forbidden);
 const granted=await x.service.setEntitlement(x.contextFor("operator","prospectus-directory"),account.id,cyclotronLab,"active");
 assert.deepEqual(granted,{accountId:account.id,product:"cyclotron",status:"active",capabilities:["console:read","console:write"]});
 assert.equal((await x.service.authorize(x.contextFor("member","cyclotron"),account.id,"console:write")).personId,x.people.member.id);
 await assert.rejects(x.service.authorize(x.contextFor("owner","cyclotron"),account.id,"members:write"),forbidden);
 assert.deepEqual(await x.service.setEntitlement(x.contextFor("operator","prospectus-directory"),account.id,cyclotronLab,"active"),granted);
 await x.service.setEntitlement(x.contextFor("operator","prospectus-directory"),account.id,cyclotronLab,"disabled");
 await assert.rejects(x.service.authorize(x.contextFor("member","cyclotron"),account.id,"console:read"),forbidden);
 assert.equal((await x.service.authorize(x.contextFor("member","papyrus"),account.id,"console:write")).personId,x.people.member.id);
 const stored=(await x.files.get<AccountDocument>(`accounts/${account.id}.json`))!.value;
 assert.equal(stored.memberships[x.people.member.id].status,"active");
 assert.deepEqual(stored.audit.map(event=>[event.type,event.target,event.status,event.actor]).slice(2),[["entitlement.changed","cyclotron","active",x.people.operator.id],["entitlement.changed","cyclotron","disabled",x.people.operator.id]]);
 assert.equal(stored.account.revision,4);
});

test("granting a product to a missing account or with an unknown status is refused",async()=>{
 const x=await serviceFixture(),operator=x.contextFor("operator","prospectus-directory");
 await assert.rejects(x.service.setEntitlement(operator,randomUUID(),{product:"cyclotron",capabilities:["console:read"]},"active"),(error:any)=>error.code==="account_missing");
 const account=await x.service.create(x.contextFor("owner","papyrus"),"Newsroom",randomUUID());
 await assert.rejects(x.service.setEntitlement(operator,account.id,{product:"cyclotron",capabilities:["console:read"]},"deleted" as any),(error:any)=>error.code==="invalid_entitlement");
});

test("the operator entitlement route requires the reviewed entitlements permission and a registered product",async()=>{
 const x=await directoryFixture();try {
  const products:ProductRegistration[]=[...x.products,{...x.products[1],product:"cyclotron",roleArn:"arn:aws:iam::111111111111:role/SyntheticCyclotron",accountDirectory:undefined,capabilities:["console:read","console:write"]}];
  const grantFor=(permission:OperatorPermission)=>({product:x.outsider.context.product,issuer:x.outsider.context.human.issuer,subjectHash:operatorSubjectHash(x.outsider.context.human.subject),permission,reviewedGrantId:"synthetic-approval-v1"});
  const central=(permissions:OperatorPermission[])=>canonicalAccountsHandler(new VirtuusIdentityFiles(x.root),new VirtuusAccountFiles(x.root),products,x.f.keys,()=>x.f.now,operatorGrants(permissions.map(grantFor)));
  const entitlementPath=(product:string)=>`/v1/account-directory/operator/accounts/${x.account.id}/entitlements/${product}`;
  const post=(handler:ReturnType<typeof central>,path:string,body:unknown,proof=x.outsider.proof)=>handler(x.f.event(0,path,body,proof,"POST"));
  assert.equal((await post(central(["accounts:admin:read"]),entitlementPath("cyclotron"),{status:"active"})).statusCode,403,"read access never grants products");
  const operator=central(["accounts:admin:read","accounts:admin:entitlements"]);
  assert.equal((await post(operator,entitlementPath("cyclotron"),{status:"active"},x.ownerDirectory.proof)).statusCode,403,"account owners cannot grant products");
  assert.equal((await post(operator,entitlementPath("unregistered"),{status:"active"})).statusCode,404);
  assert.equal((await post(operator,entitlementPath("cyclotron"),{status:"active",capabilities:["members:write"]})).statusCode,400);
  const withoutJsonContentType=x.f.event(0,entitlementPath("cyclotron"),{status:"active"},x.outsider.proof,"POST");withoutJsonContentType.headers!["content-type"]="text/plain";
  assert.equal((await operator(withoutJsonContentType)).statusCode,415);
  assert.equal((await operator({...x.f.event(0,entitlementPath("cyclotron"),{status:"active"},x.outsider.proof,"POST"),isBase64Encoded:true})).statusCode,400);
  assert.equal((await post(operator,entitlementPath("cyclotron"),{status:"active",padding:"x".repeat(12001)})).statusCode,400);
  const granted=await post(operator,entitlementPath("cyclotron"),{status:"active"});
  assert.equal(granted.statusCode,200);assert.deepEqual(JSON.parse(granted.body).entitlement,{accountId:x.account.id,product:"cyclotron",status:"active",capabilities:["console:read","console:write"]});
  const memberProducts=async()=>JSON.parse((await operator(x.f.event(0,"/v1/account-directory",{},x.memberDirectory.proof,"GET"))).body).accounts[0].products;
  assert.deepEqual(await memberProducts(),[{product:"cyclotron",status:"active"},{product:"papyrus",status:"active"}]);
  assert.equal((await post(operator,entitlementPath("cyclotron"),{status:"disabled"})).statusCode,200);
  assert.deepEqual(await memberProducts(),[{product:"cyclotron",status:"disabled"},{product:"papyrus",status:"active"}]);
 }finally{await rm(x.root,{recursive:true,force:true});}
});
