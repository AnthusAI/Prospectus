import type { ProductRegistration } from "./auth";
const operations = new Set(["console:read","console:write","members:read","members:write"]);
const rolePattern=/^arn:aws:iam::(\d{12}):role\/(?:[A-Za-z0-9+=,.@_-]+\/)*([A-Za-z0-9+=,.@_-]+)$/;
const reviewPattern=/^[A-Za-z0-9._:-]{1,128}$/;
/** Invalid/ambiguous deployment registries never become a permissive runtime. */
export function registrations(value: unknown): ProductRegistration[] {
  if(!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error("Exact product runtime registrations are required.");
  const products=new Set<string>(),roles=new Set<string>();
  for(const item of value) {
    if(!item || Object.keys(item).some(key=>!["product","roleArn","issuer","clientIds","capabilities","enabled","googleFederation","accountDirectory","executionDelegation"].includes(key)) || !/^[a-z][a-z0-9-]{0,39}$/.test(item.product) || typeof item.roleArn!=="string" || !rolePattern.test(item.roleArn)
      || !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_-]+$/.test(item.issuer) || !Array.isArray(item.clientIds) || !item.clientIds.length || item.clientIds.some((id:unknown)=>typeof id !== "string" || !/^[a-z0-9]{1,128}$/.test(id)) || !Array.isArray(item.capabilities) || !item.capabilities.length || item.capabilities.some((operation:unknown)=>!operations.has(operation as string)) || typeof item.enabled !== "boolean" || products.has(item.product)) throw new Error("Invalid or ambiguous product registration.");
    if(item.accountDirectory !== undefined && item.accountDirectory !== true)throw new Error("Directory registration must be explicitly true or absent.");
    if(item.googleFederation !== undefined) {
      const policy=item.googleFederation;
      if(!policy || Object.keys(policy).some(key=>!["policy","reviewedPolicyId","clientId"].includes(key)) || policy.policy !== "google-only-unlinked-v1" || typeof policy.reviewedPolicyId !== "string" || !reviewPattern.test(policy.reviewedPolicyId) || !item.clientIds.includes(policy.clientId)) throw new Error("An exact reviewed Google-only federation policy/client is required.");
    }
    const pair=item.executionDelegation;
    if(pair!==undefined && (!pair || Object.keys(pair).some(key=>!["roleArn","enrollmentRoleArn","issuer","clientId","enrollmentPolicyRevision","reviewedPolicyId"].includes(key)) || !item.googleFederation || item.accountDirectory || typeof pair.roleArn!=="string" || !rolePattern.test(pair.roleArn) || pair.enrollmentRoleArn!==item.roleArn || pair.issuer!==item.issuer || pair.clientId!==item.googleFederation.clientId || pair.enrollmentPolicyRevision!==item.googleFederation.reviewedPolicyId || typeof pair.reviewedPolicyId!=="string" || !reviewPattern.test(pair.reviewedPolicyId)))throw new Error("An exact reviewed enrollment-to-execution binding is required.");
    for(const principal of [item.roleArn,...(pair?[pair.roleArn]:[])]) {
      const role=rolePattern.exec(principal)!;
      // STS assumed-role evidence omits IAM paths; reject role-name collisions.
      const key=`${role[1]}:${role[2]}`;
      if(roles.has(key))throw new Error("Runtime principals must be unique and cannot delegate transitively.");
      roles.add(key);
    }
    products.add(item.product);
  }
  return value;
}
