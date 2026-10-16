import { spawn } from "node:child_process";
import { resolve } from "node:path";
export interface IdentityObject<T=any> {value:T;revision:string}
export class IdentityFileError extends Error {constructor(public code:string){super(`Identity file operation ${code}.`);}}
export interface NativeTiming {phase:"bridge"|"storage"|"initialize";operation:string;durationMs:number;success:boolean}
/** Generic conditional operations are performed by pinned Virtuus, not Node FS. */
export interface IdentityFiles {
  get<T=any>(path:string):Promise<IdentityObject<T>|null>;
  list(prefix:string):Promise<string[]>;
  commit<T>(path:string,operationId:string,requestHash:string,value:T,revision:string|null):Promise<IdentityObject<T>>;
}
class StdioIdentityFiles implements IdentityFiles {
  private child?:ReturnType<typeof spawn>;
  private closed=false;
  private queue:Promise<unknown>=Promise.resolve();
  private queued=0;
  private pending?:{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
  constructor(private environment:NodeJS.ProcessEnv,private executable:string,private localFault?:{path:string;point:"before_publication"|"after_publication"},private invocationScoped=false,private timing?:(value:NativeTiming)=>void) {
    if(!executable.startsWith("/"))throw new Error("Fixed absolute executable required.");
    if(invocationScoped)this.environment={...environment,PROSPECTUS_IDENTITY_STREAM:"1",...(timing?{PROSPECTUS_IDENTITY_TIMINGS:"1"}:{})};
  }
  close() {
    this.closed=true;
    const pending=this.pending;this.pending=undefined;
    if(pending){clearTimeout(pending.timer);pending.reject(new IdentityFileError("uncertain"));}
    this.child?.kill("SIGKILL");this.child=undefined;
  }
  private observe(value:NativeTiming) {try {this.timing?.(value);}catch{}}
  private async request(request:{action:string;[key:string]:unknown}):Promise<any> {
    if(this.closed)throw new IdentityFileError("unavailable");
    const started=performance.now();let success=false;
    try {
      if(!this.invocationScoped){const value=await this.singleRequest(request);success=true;return value;}
      if(this.queued>=32)throw new IdentityFileError("read_budget");
      this.queued++;
      const operation=this.queue.then(()=>this.streamRequest(request));
      this.queue=operation.then(()=>undefined,()=>undefined);
      try {const value=await operation;success=true;return value;} finally {this.queued--;}
    } finally {this.observe({phase:"bridge",operation:request.action,durationMs:Math.round(performance.now()-started),success});}
  }
  private streamRequest(request:unknown):Promise<any> {
    if(this.closed)return Promise.reject(new IdentityFileError("unavailable"));
    const payload=JSON.stringify(request);if(Buffer.byteLength(payload)>131072)return Promise.reject(new IdentityFileError("invalid"));
    if(!this.child) {
      const child=this.child=spawn(this.executable,[],{env:this.environment,stdio:["pipe","pipe","pipe"]});
      let output=Buffer.alloc(0),diagnostics="";
      const fail=()=>this.close();
      child.on("error",fail);child.on("close",fail);child.stdin!.on("error",fail);
      child.stdout!.on("data",(chunk:Buffer)=>{
        output=Buffer.concat([output,chunk]);if(output.length>131073){fail();return;}
        const newline=output.indexOf(10);if(newline<0)return;
        const pending=this.pending;if(!pending || newline!==output.length-1){fail();return;}
        this.pending=undefined;clearTimeout(pending.timer);
        try {const response=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(output.subarray(0,newline)));output=Buffer.alloc(0);if(response.error)pending.reject(new IdentityFileError(response.error));else if(Object.hasOwn(response,"result"))pending.resolve(response.result);else {pending.reject(new IdentityFileError("uncertain"));fail();}}
        catch {pending.reject(new IdentityFileError("uncertain"));fail();}
      });
      child.stderr!.on("data",(chunk:Buffer)=>{
        diagnostics+=chunk.toString("utf8");if(diagnostics.length>16384){diagnostics="";return;}
        let newline;while((newline=diagnostics.indexOf("\n"))>=0) {
          const line=diagnostics.slice(0,newline);diagnostics=diagnostics.slice(newline+1);
          try {const value=JSON.parse(line);if(["storage","initialize"].includes(value.phase) && ["configure","head_bucket","get","get_bounded","list","put","delete","get_control","put_control"].includes(value.operation) && Number.isSafeInteger(value.durationMs) && value.durationMs>=0 && typeof value.success==="boolean")this.observe({phase:value.phase,operation:value.operation,durationMs:value.durationMs,success:value.success});}catch{}
        }
      });
    }
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.close(),60000);
      this.pending={resolve,reject,timer};this.child!.stdin!.write(payload+"\n");
    });
  }
  private singleRequest(request:unknown):Promise<any> {
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
  constructor(root:string,executable=resolve(".build/intake-control-target/debug/prospectus-identity-files"),localFault?:{path:string;point:"before_publication"|"after_publication"},invocationScoped=false,timing?:(value:NativeTiming)=>void) {
    if(!root.startsWith("/"))throw new Error("Fixed absolute local root required.");
    super({PATH:process.env.PATH,PROSPECTUS_IDENTITY_FILES_ROOT:root},executable,localFault,invocationScoped,timing);
  }
}
export interface S3IdentityConfiguration {enabled:true;bucket:string;region:"us-east-1";expectedOwner:string;tenant:string;project:"identities"|"accounts"}
/** Server-selected configuration only. Never accept a browser bucket, scope or endpoint. */
export class VirtuusS3IdentityFiles extends StdioIdentityFiles {
  constructor(config:S3IdentityConfiguration,executable=resolve(".build/intake-control-target/debug/prospectus-identity-files"),invocationScoped=false,timing?:(value:NativeTiming)=>void) {
    if(config.enabled!==true || config.region!=="us-east-1" || !/^[0-9]{12}$/.test(config.expectedOwner) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(config.tenant) || !["identities","accounts"].includes(config.project))throw new Error("Explicit fixed S3 identity configuration required.");
    // Existing runtime temporary credentials/profile only; no creation or persistence.
    const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME};
    for(const key of ["AWS_PROFILE","AWS_CONFIG_FILE","AWS_SHARED_CREDENTIALS_FILE","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_CONTAINER_CREDENTIALS_RELATIVE_URI","AWS_CONTAINER_CREDENTIALS_FULL_URI","AWS_CONTAINER_AUTHORIZATION_TOKEN","AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE","AWS_WEB_IDENTITY_TOKEN_FILE","AWS_ROLE_ARN","AWS_ROLE_SESSION_NAME","AWS_EC2_METADATA_DISABLED"])if(process.env[key])environment[key]=process.env[key];
    Object.assign(environment,{AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:"true",AWS_REGION:config.region,PROSPECTUS_IDENTITY_BACKEND:"s3",PROSPECTUS_IDENTITY_S3_ENABLED:"true",PROSPECTUS_IDENTITY_BUCKET:config.bucket,PROSPECTUS_IDENTITY_REGION:config.region,PROSPECTUS_IDENTITY_EXPECTED_OWNER:config.expectedOwner,PROSPECTUS_IDENTITY_TENANT:config.tenant,PROSPECTUS_IDENTITY_PROJECT:config.project});
    super(environment,executable,undefined,invocationScoped,timing);
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
 constructor(config:Omit<S3IdentityConfiguration,"project">,executable?:string,invocationScoped=false,timing?:(value:NativeTiming)=>void){super({...config,project:"accounts"},executable,invocationScoped,timing);}
}
