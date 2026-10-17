import type {ProductRegistration} from "./auth";
import type {Operation} from "./model";
/** Reviewed Papyrus site entries. Each site reads its people's accounts; account creation and membership writes stay with other products. */
export interface PapyrusSiteEntry {
 product:string;
 roleArn:string;
 issuer:string;
 clientId:string;
 federationReviewId:string;
 siteReviewId:string;
}
export const papyrusSiteCapabilities:readonly Operation[]=["console:read","console:write","members:read"];
export const papyrusSiteRoutes:readonly string[]=["GET/v1/identities/me","POST/v1/identities/google/challenge","POST/v1/identities/google/resolve","GET/v1/accounts","GET/v1/accounts/*","POST/v1/accounts/*/authorize","GET/v1/account-directory","GET/v1/account-directory/*"];
const reviewIdentifierPattern=/^[A-Za-z0-9._:-]{1,128}$/;
const siteRolePattern=/^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]+$/;
export function papyrusSiteRegistrations(value:unknown):ProductRegistration[] {
 if(!Array.isArray(value) || value.length>40)throw new Error("Reviewed Papyrus site registrations are required.");
 const products=new Set<string>(),roles=new Set<string>();
 return value.map((site:PapyrusSiteEntry)=>{
  if(!site || typeof site!=="object" || Object.keys(site).sort().join(",")!=="clientId,federationReviewId,issuer,product,roleArn,siteReviewId" || typeof site.product!=="string" || !/^papyrus-[a-z0-9][a-z0-9-]{0,31}$/.test(site.product) || typeof site.roleArn!=="string" || !siteRolePattern.test(site.roleArn) || typeof site.issuer!=="string" || !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_-]+$/.test(site.issuer) || typeof site.clientId!=="string" || !/^[a-z0-9]{1,128}$/.test(site.clientId) || typeof site.federationReviewId!=="string" || !reviewIdentifierPattern.test(site.federationReviewId) || typeof site.siteReviewId!=="string" || !reviewIdentifierPattern.test(site.siteReviewId))throw new Error("Exact reviewed Papyrus site registration required.");
  if(products.has(site.product) || roles.has(site.roleArn))throw new Error("Each Papyrus site needs its own product name and runtime role.");
  products.add(site.product);roles.add(site.roleArn);
  return {product:site.product,roleArn:site.roleArn,issuer:site.issuer,clientIds:[site.clientId],capabilities:[...papyrusSiteCapabilities],enabled:true,accountDirectory:true as const,googleFederation:{policy:"google-only-unlinked-v1" as const,reviewedPolicyId:site.federationReviewId,clientId:site.clientId}};
 });
}
