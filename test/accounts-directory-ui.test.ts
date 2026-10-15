import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "vite";
import {chromium,expect} from "@playwright/test";
test("Accounts UI renders loading empty error and scoped list/detail without granting actions",{skip:!process.env.PROSPECTUS_ACCOUNTS_UI},async()=>{
 const server=await createServer({configFile:false,root:process.cwd(),server:{host:"127.0.0.1",port:0},resolve:{dedupe:["react","react-dom"]},logLevel:"error"});await server.listen();const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try {
  const page=await browser.newPage(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));let mode="loading",release:(()=>void)|undefined;
  await page.route("**/directory-fixture/accounts**",async route=>{
   if(mode==="loading")await new Promise<void>(resolve=>{release=resolve;});
   if(mode==="error"){await route.fulfill({status:503,body:"{}"});return;}
   const account={id:"11111111-1111-4111-8111-111111111111",name:"Synthetic Alpha",role:mode==="admin"?"admin":"viewer",products:[{product:"cyclotron",status:"active"}]};
   const detail=route.request().url().endsWith(account.id);await route.fulfill({contentType:"application/json",body:JSON.stringify(detail?{account:{...account,createdAt:"2030-01-01",revision:1,entitlements:[{accountId:account.id,product:"cyclotron",status:"active",capabilities:["console:read"]}],memberships:[{personId:"synthetic-person",role:account.role,status:"active"}],membershipsVisible:mode==="admin"}}:{person:mode==="identity"?null:{id:"synthetic-person",createdAt:"2030-01-01"},accounts:["empty","identity"].includes(mode)?[]:[account]})});
  });
  const url=`${server.resolvedUrls!.local[0]}test/accounts-directory-fixture/index.html`;
  await page.goto(url);await expect(page.getByRole("status")).toHaveText("Loading accounts…");mode="empty";release!();await expect(page.getByRole("status")).toContainText("do not have any SaaS accounts");
  mode="error";await page.getByRole("button",{name:"Refresh accounts"}).click();await expect(page.getByRole("alert")).toContainText("could not be loaded");
  mode="identity";await page.getByRole("button",{name:"Refresh accounts"}).click();await expect(page.getByRole("button",{name:"Connect Accounts with Google"})).toBeVisible();
  for(const role of ["viewer","admin"]) {mode=role;await page.getByRole("button",{name:"Refresh accounts"}).click();await page.getByRole("button",{name:/Synthetic Alpha/}).click();await expect(page.getByRole("heading",{name:role==="admin"?"Memberships":"Your membership",exact:true})).toBeVisible();await expect(page.getByRole("heading",{name:"Product entitlements"})).toBeVisible();}
  mode="loading";await page.getByRole("button",{name:/Synthetic Alpha/}).click();await expect(page.getByRole("status")).toHaveText("Loading account details…");
  mode="admin";await page.getByRole("button",{name:"Refresh accounts"}).click();await expect(page.getByText("Select an account to see details.")).toBeVisible();release!();await expect(page.getByText("Select an account to see details.")).toBeVisible();
  await page.goto(`${url}?mode=unconfigured`);await expect(page.getByRole("alert")).toContainText("not been configured");assert.deepEqual(errors,[]);
 } finally {await browser.close();await server.close();}
});
