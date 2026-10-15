import { spawn } from "node:child_process";
import { resolve } from "node:path";
export interface IdentityObject<T=any> {value:T;revision:string}
export class IdentityFileError extends Error {constructor(public code:string){super(`Identity file operation ${code}.`);}}
/** Generic conditional operations are performed by pinned Virtuus, not Node FS. */
export interface IdentityFiles {
  get<T=any>(path:string):Promise<IdentityObject<T>|null>;
  list(prefix:string):Promise<string[]>;
  commit<T>(path:string,operationId:string,requestHash:string,value:T,revision:string|null):Promise<IdentityObject<T>>;
}
class StdioIdentityFiles implements IdentityFiles {
  constructor(private environment:NodeJS.ProcessEnv,private executable:string,private localFault?:{path:string;point:"before_publication"|"after_publication"}) {
    if(!executable.startsWith("/"))throw new Error("Fixed absolute executable required.");
  }
  private request(request:unknown):Promise<any> {
    const payload=JSON.stringify(request);if(Buffer.byteLength(payload)>131072)throw new IdentityFileError("invalid");
    return new Promise((resolve,reject)=>{
      const child=spawn(this.executable,[],{env:this.environment,stdio:["pipe","pipe","ignore"]});
      let output=Buffer.alloc(0),done=false;
      const finish=(error?:Error,value?:unknown)=>{if(done)return;done=true;clearTimeout(timer);if(error && child.exitCode===null)child.kill("SIGKILL");error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(new IdentityFileError("uncertain")),60000);
      child.on("error",()=>finish(new IdentityFileError("unavailable")));
      child.stdin.on("error",()=>finish(new IdentityFileError("uncertain")));
      child.stdout.on("data",(chunk:Buffer)=>{output=Buffer.concat([output,chunk]);if(output.length>131072)finish(new IdentityFileError("uncertain"));});
      child.on("close",code=>{
        if(code!==0){finish(new IdentityFileError("uncertain"));return;}
        try {const response=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(output));if(response.error)finish(new IdentityFileError(response.error));else finish(undefined,response.result);}
        catch{finish(new IdentityFileError("uncertain"));}
      });
      child.stdin.end(payload);
    });
  }
  get<T=any>(path:string):Promise<IdentityObject<T>|null>{return this.request({action:"get",path});}
  async list(prefix:string) {
    const paths:string[]=[];let cursor:string|null=null;
    do {const page=await this.request({action:"list",path:prefix,cursor});paths.push(...page.paths);if(paths.length>256)throw new IdentityFileError("read_budget");cursor=page.nextCursor;}while(cursor);
    return paths;
  }
  commit<T>(path:string,operationId:string,requestHash:string,value:T,revision:string|null):Promise<IdentityObject<T>> {
    return this.request({action:"commit",path,operation_id:operationId,request_hash:requestHash,value,revision,...(this.localFault?.path===path?{fault:this.localFault.point}:{})});
  }
}

/** Existing local transport: no credential environment is inherited. */
export class VirtuusIdentityFiles extends StdioIdentityFiles {
  constructor(root:string,executable=resolve(".build/intake-control-target/debug/prospectus-identity-files"),localFault?:{path:string;point:"before_publication"|"after_publication"}) {
    if(!root.startsWith("/"))throw new Error("Fixed absolute local root required.");
    super({PATH:process.env.PATH,PROSPECTUS_IDENTITY_FILES_ROOT:root},executable,localFault);
  }
}
export interface S3IdentityConfiguration {enabled:true;bucket:string;region:"us-east-1";expectedOwner:string;tenant:string;project:"identities"|"accounts"}
/** Server-selected configuration only. Never accept a browser bucket, scope or endpoint. */
export class VirtuusS3IdentityFiles extends StdioIdentityFiles {
  constructor(config:S3IdentityConfiguration,executable=resolve(".build/intake-control-target/debug/prospectus-identity-files")) {
    if(config.enabled!==true || config.region!=="us-east-1" || !/^[0-9]{12}$/.test(config.expectedOwner) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(config.tenant) || !["identities","accounts"].includes(config.project))throw new Error("Explicit fixed S3 identity configuration required.");
    // Existing runtime temporary credentials/profile only; no creation or persistence.
    const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME};
    for(const key of ["AWS_PROFILE","AWS_CONFIG_FILE","AWS_SHARED_CREDENTIALS_FILE","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_CONTAINER_CREDENTIALS_RELATIVE_URI","AWS_CONTAINER_CREDENTIALS_FULL_URI","AWS_CONTAINER_AUTHORIZATION_TOKEN","AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE","AWS_WEB_IDENTITY_TOKEN_FILE","AWS_ROLE_ARN","AWS_ROLE_SESSION_NAME","AWS_EC2_METADATA_DISABLED"])if(process.env[key])environment[key]=process.env[key];
    Object.assign(environment,{AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:"true",AWS_REGION:config.region,PROSPECTUS_IDENTITY_BACKEND:"s3",PROSPECTUS_IDENTITY_S3_ENABLED:"true",PROSPECTUS_IDENTITY_BUCKET:config.bucket,PROSPECTUS_IDENTITY_REGION:config.region,PROSPECTUS_IDENTITY_EXPECTED_OWNER:config.expectedOwner,PROSPECTUS_IDENTITY_TENANT:config.tenant,PROSPECTUS_IDENTITY_PROJECT:config.project});
    super(environment,executable);
  }
}

/** Canonical accounts use a separate fixed Virtuus project, never identity files. */
export class VirtuusAccountFiles extends StdioIdentityFiles {
  constructor(root:string,executable=resolve(".build/intake-control-target/debug/prospectus-identity-files"),localFault?:{path:string;point:"before_publication"|"after_publication"}) {
    if(!root.startsWith("/"))throw new Error("Fixed absolute local root required.");
    super({PATH:process.env.PATH,PROSPECTUS_IDENTITY_FILES_ROOT:root,PROSPECTUS_IDENTITY_PROJECT:"accounts"},executable,localFault);
  }
}

export class VirtuusS3AccountFiles extends VirtuusS3IdentityFiles {
 constructor(config:Omit<S3IdentityConfiguration,"project">,executable?:string){super({...config,project:"accounts"},executable);}
}
