import { AccountsError, fail, UUID_PATTERN, type Operation, type Role } from "./model";
import { AccountsService } from "./service";
import { caller, context, human, type KeyResolver, type ProductRegistration, type RestEvent } from "./auth";
export type AccountsApi = Pick<AccountsService,"resolve"|"link"|"list"|"create"|"get"|"authorize"|"setMembership">;
export function accountHandler(service: AccountsApi, products: readonly ProductRegistration[], keys: KeyResolver, nowSeconds = () => Date.now()/1000) {
  return async (event: RestEvent) => {
    const response = (statusCode: number, value: unknown) => ({statusCode,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"},body:JSON.stringify(value)});
    try {
      const authenticated = await context(event,products,keys,nowSeconds());
      const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key,value])=>[key.toLowerCase(),value]));
      if(event.isBase64Encoded || Buffer.byteLength(event.body ?? "") > 12000) fail(400,"body","Unsupported account payload.");
      let body: any = {};
      if(event.body) {
        if(headers["content-type"]?.split(";")[0] !== "application/json") fail(415,"json_required","JSON required.");
        try { body=JSON.parse(event.body); } catch { fail(400,"json","Invalid JSON."); }
        if(!body || typeof body !== "object" || Array.isArray(body)) fail(400,"body","Object required.");
      }
      const fields = (allowed: string[]) => { if(Object.keys(body).some(key=>!allowed.includes(key))) fail(400,"unknown_fields","Unsupported account fields."); };
      if(event.path === "/v1/identities/resolve" && event.httpMethod === "POST") { fields([]);return response(200,{person:await service.resolve(authenticated)}); }
      if(event.path === "/v1/identities/link" && event.httpMethod === "POST") {
        fields([]);
        const registration = caller(event,products).registration;
        await human(headers["x-prospectus-human-token"],registration,keys,nowSeconds(),300);
        const proof = await human(headers["x-prospectus-link-token"],registration,keys,nowSeconds(),300);
        return response(200,{person:await service.link(authenticated,proof)});
      }
      if(event.path === "/v1/accounts" && event.httpMethod === "GET") { fields([]);return response(200,await service.list(authenticated)); }
      if(event.path === "/v1/accounts" && event.httpMethod === "POST") { fields(["name"]);return response(200,{account:await service.create(authenticated,body.name,headers["idempotency-key"] ?? "")}); }
      const route = /^\/v1\/accounts\/([a-f0-9-]{36})(?:\/(authorize|memberships))?$/.exec(event.path);
      if(!route) fail(404,"route","Account route not found.");
      if(!route[2] && event.httpMethod === "GET") { fields([]);return response(200,{account:await service.get(authenticated,route[1])}); }
      if(route[2] === "authorize" && event.httpMethod === "POST") { fields(["operation"]);return response(200,await service.authorize(authenticated,route[1],body.operation as Operation)); }
      if(route[2] === "memberships" && event.httpMethod === "POST") {
        fields(["personId","role","status"]);
        if(typeof body.personId !== "string" || !UUID_PATTERN.test(body.personId)) fail(400,"person","Known person ID required.");
        return response(200,{membership:await service.setMembership(authenticated,route[1],body.personId,body.role as Role,body.status)});
      }
      fail(404,"route","Account route not found.");
    } catch(error) {
      if(error instanceof AccountsError) return response(error.status,{error:error.code,message:error.message});
      return response(503,{error:"accounts_unavailable",message:"Account service unavailable. Retry with the same request key."});
    }
  };
}
