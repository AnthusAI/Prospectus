import {getAccessToken} from "./auth";
import type {DirectoryReader,DirectoryDetail,DirectoryList} from "../packages/accounts-client/src/directory";
export class DirectoryError extends Error {constructor(public status:number,message:string){super(message);}}
export interface AccountsBrowser extends DirectoryReader {configured:boolean;challenge():Promise<{challengeId:string;nonce:string}>;resolve(challengeId:string,idToken:string,accessToken:string):Promise<void>}
export function accountsBrowser(base:string|undefined,fetcher:typeof fetch=fetch,token:()=>string|null=getAccessToken):AccountsBrowser {
 const root=base?.replace(/\/$/,"");
 async function request(path:string,method="GET",body?:unknown,access=token()) {
  if(!root)throw new DirectoryError(503,"The Accounts service has not been configured.");if(!access)throw new DirectoryError(401,"Sign in again to view accounts.");
  const response=await fetcher(`${root}${path}`,{method,cache:"no-store",redirect:"error",headers:{authorization:`Bearer ${access}`,...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  const value=await response.json().catch(()=>null);if(!response.ok)throw new DirectoryError(response.status,response.status===403?"You do not have access to this account.":response.status===401?"Sign in again to view accounts.":"Accounts could not be loaded. Try again.");return value;
 }
 return {configured:!!root,list:()=>request("/accounts") as Promise<DirectoryList>,detail:async(id:string)=>(await request(`/accounts/${encodeURIComponent(id)}`)).account as DirectoryDetail,challenge:()=>request("/identity/challenge","POST",{}),resolve:async(challengeId,idToken,access)=>{await request("/identity/resolve","POST",{challengeId,idToken},access);}};
}
