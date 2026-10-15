import type { ProductRegistration } from "./auth";
const operations = new Set(["console:read","console:write","members:read","members:write"]);
/** Invalid/ambiguous deployment registries never become a permissive runtime. */
export function registrations(value: unknown): ProductRegistration[] {
  if(!Array.isArray(value) || value.length === 0 || value.length > 20) throw new Error("Exact product runtime registrations are required.");
  const products=new Set<string>(),roles=new Set<string>();
  for(const item of value) {
    if(!item || Object.keys(item).some(key=>!["product","roleArn","issuer","clientIds","capabilities","enabled","googleFederation","accountDirectory"].includes(key)) || !/^[a-z][a-z0-9-]{0,39}$/.test(item.product) || !/^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]+$/.test(item.roleArn)
      || !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_-]+$/.test(item.issuer) || !Array.isArray(item.clientIds) || !item.clientIds.length || item.clientIds.some((id:unknown)=>typeof id !== "string" || !/^[a-z0-9]{1,128}$/.test(id)) || !Array.isArray(item.capabilities) || !item.capabilities.length || item.capabilities.some((operation:unknown)=>!operations.has(operation as string)) || typeof item.enabled !== "boolean" || products.has(item.product) || roles.has(item.roleArn)) throw new Error("Invalid or ambiguous product registration.");
    if(item.accountDirectory !== undefined && item.accountDirectory !== true)throw new Error("Directory registration must be explicitly true or absent.");
    if(item.googleFederation !== undefined) {
      const policy=item.googleFederation;
      if(!policy || Object.keys(policy).some(key=>!["policy","reviewedPolicyId","clientId"].includes(key)) || policy.policy !== "google-only-unlinked-v1" || typeof policy.reviewedPolicyId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(policy.reviewedPolicyId) || !item.clientIds.includes(policy.clientId)) throw new Error("An exact reviewed Google-only federation policy/client is required.");
    }
    products.add(item.product);roles.add(item.roleArn);
  }
  return value;
}
