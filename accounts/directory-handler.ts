import {context,type ProductRegistration,type KeyResolver,type RestEvent} from "./auth";
import {AccountsError,fail,roleOperations} from "./model";
import {DurableAccountsService,type AccountDocument} from "./durable-accounts";
import type {IdentityFiles} from "./identity-files";
import type {DirectoryAccount,DirectoryDetail} from "../packages/accounts-client/src/directory";
/** Registered read-only management surface; account membership is always required.
 * It may read across product entitlements, never create them or authorize app use.
 */
export function accountDirectoryHandler(service:DurableAccountsService,files:IdentityFiles,products:readonly ProductRegistration[],keys:KeyResolver,clock=()=>Date.now()/1000) {
 const summary=(document:AccountDocument,personId:string):DirectoryAccount|null=>{
  const membership=document.memberships[personId];if(!membership || membership.status!=="active")return null;
  return {id:document.account.id,name:document.account.name,role:membership.role,products:Object.values(document.entitlements).map(({product,status})=>({product,status})).sort((a,b)=>a.product.localeCompare(b.product))};
 };
 return async(event:RestEvent)=>{
  const response=(statusCode:number,value:unknown)=>({statusCode,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"},body:JSON.stringify(value)});
  try {
   const authenticated=await context(event,products,keys,clock());
   if(!products.some(product=>product.enabled && product.product===authenticated.product && product.roleArn===authenticated.principal && product.accountDirectory===true) || !authenticated.capabilities.includes("console:read"))fail(403,"directory_forbidden","Account directory access is not registered.");
   if(event.httpMethod!=="GET" || event.body && event.body!=="{}")fail(400,"read_only","Account directory supports read requests only.");
   let person;try{person=await service.person(authenticated);}catch(error){if(error instanceof AccountsError && error.code==="identity_enrollment_required" && event.path==="/v1/account-directory")return response(200,{person:null,accounts:[]});throw error;}
   if(event.path==="/v1/account-directory") {
    const paths=await files.list("accounts/");if(paths.length>256)fail(503,"account_read_budget","Account discovery budget exceeded.");const accounts:DirectoryAccount[]=[];
    for(const path of paths) {const match=/^accounts\/([a-f0-9-]{36})\.json$/.exec(path);if(!match)fail(503,"account_inconsistent","Invalid account path.");const stored=await service.read(match[1]);if(!stored)fail(503,"account_inconsistent","Account unavailable during discovery.");const account=summary(stored.value,person.id);if(account)accounts.push(account);}
    return response(200,{person,accounts:accounts.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id))});
   }
   const match=/^\/v1\/account-directory\/([a-f0-9-]{36})$/.exec(event.path);if(!match)fail(404,"route","Account directory route not found.");
   const stored=await service.read(match[1]),account=stored?summary(stored.value,person.id):null;if(!account || !stored)fail(403,"forbidden","Account details are not permitted.");
   const membershipsVisible=authenticated.capabilities.includes("members:read") && roleOperations[account.role].includes("members:read");
   const detail:DirectoryDetail={...account,createdAt:stored.value.account.createdAt,revision:stored.value.account.revision,entitlements:structuredClone(Object.values(stored.value.entitlements)),memberships:structuredClone(membershipsVisible?Object.values(stored.value.memberships):[stored.value.memberships[person.id]]),membershipsVisible};
   return response(200,{account:detail});
  } catch(error){if(error instanceof AccountsError)return response(error.status,{error:error.code,message:error.message});return response(503,{error:"accounts_unavailable",message:"Accounts are unavailable. Try again."});}
 };
}
