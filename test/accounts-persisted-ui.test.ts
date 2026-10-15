import {test} from "node:test";
import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import {createServer} from "vite";
import {chromium,expect} from "@playwright/test";
import {canonicalAccountsHandler} from "../accounts/canonical-handler";
import {VirtuusIdentityFiles,VirtuusAccountFiles} from "../accounts/identity-files";
import {directoryFixture} from "../accounts/testing/directory-fixture";
import {accountsBffHandler} from "../accounts/bff";
import {AccountsClient,decode} from "../packages/accounts-client/src/client";
test("browser list and owner/member detail come from real persisted canonical account responses",{skip:!process.env.PROSPECTUS_ACCOUNTS_UI},async()=>{
 const x=await directoryFixture();let activeCentral=x.handler();const bff=accountsBffHandler({origin:"https://prospectus.anth.us",registration:x.products[0],keys:x.f.keys,nowSeconds:()=>x.f.now,client:(access,id)=>new AccountsClient(async(path,method,body)=>{const event=x.f.event(0,path,body??{},x.ownerDirectory.proof,method);event.headers!["x-prospectus-human-token"]=access;if(id)event.headers!["x-prospectus-identity-token"]=id;const result=await activeCentral(event);return decode(new Response(result.body,{status:result.statusCode}));})});
 const server=await createServer({configFile:false,root:process.cwd(),resolve:{dedupe:["react","react-dom"]},server:{host:"127.0.0.1",port:0},logLevel:"error",plugins:[{name:"synthetic-persisted-directory",configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(!req.url?.startsWith("/directory-fixture/")){next();return;}
  // Test identity adapter only; production BFF itself verifies actual RSA JWTs.
  const name=req.headers.authorization?.slice(7),actor=name==="owner"?x.ownerDirectory:name==="member"?x.memberDirectory:x.outsider;
  const response=await bff({rawPath:req.url.replace("/directory-fixture","/api/saas"),requestContext:{http:{method:"GET"}},headers:{authorization:`Bearer ${actor.proof.access}`}});res.writeHead(response.statusCode,response.headers);res.end(response.body);
 });}}]});await server.listen();const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try {
  const page=await browser.newPage(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  for(const name of ["owner","member"]) {await page.goto(`${server.resolvedUrls!.local[0]}test/accounts-directory-fixture/index.html?person=${name}`);await page.getByRole("button",{name:/Persisted Papyrus organization/}).click();await expect(page.getByRole("heading",{name:name==="owner"?"Memberships":"Your membership",exact:true})).toBeVisible();await expect(page.getByText(x.account.id,{exact:true})).toBeVisible();}
  await page.goto(`${server.resolvedUrls!.local[0]}test/accounts-directory-fixture/index.html?person=outsider`);await expect(page.getByRole("status")).toContainText("do not have any SaaS accounts");await page.getByRole("button",{name:"Account administration",exact:true}).click();await expect(page.getByRole("status")).toContainText("explicitly assigned central Accounts administrator permission");
  activeCentral=canonicalAccountsHandler(new VirtuusIdentityFiles(x.root),new VirtuusAccountFiles(x.root),x.products,x.f.keys,()=>x.f.now,[{product:x.outsider.context.product,issuer:x.outsider.context.human.issuer,subject:x.outsider.context.human.subject,permission:"accounts:admin:read",reviewedGrantId:"synthetic-browser-approval"}]);
  await page.reload();await page.getByRole("button",{name:/Persisted Papyrus organization/}).click();await expect(page.getByRole("heading",{name:"Organization memberships"})).toBeVisible();await expect(page.getByText(x.account.id,{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"My memberships",exact:true}).click();await expect(page.getByRole("status")).toContainText("do not have any SaaS accounts");
  await page.getByRole("button",{name:"Account administration",exact:true}).click();await expect(page.getByRole("button",{name:/Persisted Papyrus organization/})).toBeVisible();
  activeCentral=x.handler();await page.getByRole("button",{name:"Refresh directory"}).click();await expect(page.getByRole("alert")).toContainText("permission may have changed");
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await server.close();await rm(x.root,{recursive:true,force:true});}
});
