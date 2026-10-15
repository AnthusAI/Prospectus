import type {IdentityFiles} from "./identity-files";
import type {KeyResolver,ProductRegistration,RestEvent} from "./auth";
import {DurableGoogleIdentities} from "./durable-google-identities";
import {DurableAccountsService} from "./durable-accounts";
import {googlePersonDirectory} from "./person-directory";
import {googleIdentityHandler} from "./google-identity";
import {accountDirectoryHandler} from "./directory-handler";
import {operatorGrants,type OperatorGrant} from "./operator-policy";
import {accountHandler} from "./handler";
/** Trusted runtime composition, intentionally no AWS configuration, resource
 * provisioning. Deployment bootstrap is separate. File adapters/namespaces are server-owned.
 */
export function canonicalAccountsHandler(identityFiles:IdentityFiles,accountFiles:IdentityFiles,products:readonly ProductRegistration[],keys:KeyResolver,nowSeconds=()=>Date.now()/1000,grants:readonly OperatorGrant[]=[]) {
 const reviewedGrants=operatorGrants(grants);
 const repository=new DurableGoogleIdentities(identityFiles),directory=googlePersonDirectory(repository,products);
 const identity=googleIdentityHandler(repository,products,keys,nowSeconds);
 const service=new DurableAccountsService(accountFiles,directory,()=>new Date(nowSeconds()*1000).toISOString());
 const accounts=accountHandler(service,products,keys,nowSeconds);
 const directoryHandler=accountDirectoryHandler(service,accountFiles,products,keys,nowSeconds,reviewedGrants);
 return (event:RestEvent)=>event.path.startsWith("/v1/account-directory")?directoryHandler(event):event.path.startsWith("/v1/accounts") || ["/v1/identities/resolve","/v1/identities/link"].includes(event.path)?accounts(event):identity(event);
}
