import { createHash, randomUUID } from "node:crypto";
import { IdentityFileError, type IdentityFiles, type IdentityObject } from "./identity-files";
import { GOOGLE_ISSUER, sameBinding, type GoogleAlias, type GoogleAssociation, type GoogleIdentityRepository, type IdentitySession, type LoginChallenge } from "./google-identity";
import { fail, UUID_PATTERN, type Person } from "./model";

const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const googleIdentityKey=(subject:string)=>hash(["google-v1",GOOGLE_ISSUER,subject]);
export const cognitoAliasKey=(issuer:string,subject:string)=>hash(["cognito-v1",issuer,subject]);
export type EnrollmentPhase="issue"|"prepare"|"google"|"alias"|"person"|"session"|"complete";
export type EnrollmentHook=(phase:EnrollmentPhase,point:"before"|"after")=>void|Promise<void>;
interface GoogleRecord {version:1;kind:"google";issuer:string;subject:string;person:Person}
interface AliasRecord {version:1;kind:"alias";issuer:string;subject:string;googleKey:string;personId:string;createdAt:string}
interface LoginRecord {version:1;kind:"login";state:"pending"|"prepared"|"committed"|"conflicted";challenge:LoginChallenge;proof?:GoogleAssociation;candidate?:Person;person?:Person}
interface SessionPointer {version:1;kind:"session";challengeId:string;googleKey:string;aliasKey:string;personId:string}

/** Recoverable multi-file enrollment. Only committed logins expose identities.
 * All writes use Virtuus journals/CAS; no process mutex, lease timeout or DDB.
 * Files may reserve an identity before completion but can never grant access then.
 */
export class DurableGoogleIdentities implements GoogleIdentityRepository {
  constructor(private files:IdentityFiles,private hook:EnrollmentHook=()=>{}){}
  private async step<T>(phase:EnrollmentPhase,work:()=>Promise<T>):Promise<T>{await this.hook(phase,"before");const result=await work();await this.hook(phase,"after");return result;}
  private write<T>(path:string,operationId:string,value:T,revision:string|null,logical:unknown=value) {
    return this.files.commit(path,operationId,hash(["identity-v1",path,logical]),value,revision);
  }
  async issue(challenge:LoginChallenge) {
    await this.step("issue",()=>this.write(`logins/${challenge.challengeId}.json`,`identity:${challenge.challengeId}:issue`,{version:1,kind:"login",state:"pending",challenge} satisfies LoginRecord,null));
  }
  private loginValid(record:LoginRecord,id:string) {
    if(record?.version!==1 || record.kind!=="login" || record.challenge?.challengeId!==id || !["pending","prepared","committed","conflicted"].includes(record.state))fail(503,"identity_inconsistent","Invalid canonical login record.");
  }
  async associate(proof:GoogleAssociation):Promise<Person> {
    const path=`logins/${proof.challengeId}.json`;let stored=await this.files.get<LoginRecord>(path);
    if(!stored)fail(401,"challenge_invalid","Challenge does not exist.");
    this.loginValid(stored.value,proof.challengeId);
    const prior=stored.value;
    if(prior.challenge.expiresAt<=proof.now || prior.challenge.issuedAt>proof.now || prior.challenge.nonce!==proof.nonce)fail(401,"challenge_invalid","Challenge expired or does not match evidence.");
    if(!sameBinding(prior.challenge.binding,proof.binding))fail(403,"challenge_binding","Challenge belongs to another product/client/policy.");
    if(prior.proof && prior.proof.fingerprint!==proof.fingerprint)fail(409,"challenge_replay","Challenge already consumed with different evidence.");
    if(prior.state==="conflicted")fail(409,"identity_conflict","Existing identity mapping conflicts.");
    if(prior.state==="pending") {
      const prepared:LoginRecord={...prior,state:"prepared",proof:structuredClone(proof),candidate:{id:randomUUID(),createdAt:new Date(proof.now*1000).toISOString()}};
      try {stored=await this.step("prepare",()=>this.write(path,`identity:${proof.challengeId}:prepare`,prepared,stored!.revision,{fingerprint:proof.fingerprint}));}
      catch(error){if(error instanceof IdentityFileError && error.code==="operation_mismatch")fail(409,"challenge_replay","Challenge already claimed with different evidence.");throw error;}
    }
    return this.finish(stored);
  }
  /** Trusted internal repair only. Never accepts JWTs or authorizes an API caller.
   * Prepared decisions survive expiry; the API still requires fresh valid proofs.
   */
  async recover(challengeId:string):Promise<Person|null> {
    if(!UUID_PATTERN.test(challengeId))fail(400,"challenge_invalid","Invalid challenge ID.");
    const stored=await this.files.get<LoginRecord>(`logins/${challengeId}.json`);if(!stored)return null;
    this.loginValid(stored.value,challengeId);if(stored.value.state==="pending")return null;
    if(stored.value.state==="conflicted")fail(409,"identity_conflict","Existing identity mapping conflicts.");
    return this.finish(stored);
  }
  private checkGoogle(value:GoogleRecord,subject:string) {
    if(value?.version!==1 || value.kind!=="google" || value.issuer!==GOOGLE_ISSUER || value.subject!==subject || !UUID_PATTERN.test(value.person?.id) || !Number.isFinite(Date.parse(value.person?.createdAt)))fail(503,"identity_inconsistent","Canonical Google identity is inconsistent.");
  }
  private async ensure<T>(path:string,operation:string,value:T,accept:(current:T)=>boolean):Promise<T> {
    try {await this.write(path,operation,value,null);}
    catch(error){if(!(error instanceof IdentityFileError && error.code==="conflict"))throw error;}
    const current=await this.files.get<T>(path);
    if(!current || !accept(current.value))fail(409,"identity_conflict","Canonical identity reservation conflicts; no automatic merge.");
    return current.value;
  }
  private async finish(stored:IdentityObject<LoginRecord>):Promise<Person> {
    const record=stored.value;const proof=record.proof;const candidate=record.candidate;
    if(!proof || !candidate || proof.challengeId!==record.challenge.challengeId || !sameBinding(proof.binding,record.challenge.binding))fail(503,"identity_inconsistent","Enrollment intent is incomplete.");
    const id=record.challenge.challengeId,googleKey=googleIdentityKey(proof.googleSubject),aliasKey=cognitoAliasKey(proof.binding.issuer,proof.cognitoSubject);
    const google=await this.step("google",()=>this.ensure<GoogleRecord>(`google/${googleKey}.json`,`identity:${id}:google`,{version:1,kind:"google",issuer:GOOGLE_ISSUER,subject:proof.googleSubject,person:candidate},value=>value?.kind==="google" && value.issuer===GOOGLE_ISSUER && value.subject===proof.googleSubject));
    this.checkGoogle(google,proof.googleSubject);
    try {
      await this.step("alias",()=>this.ensure<AliasRecord>(`aliases/${aliasKey}.json`,`identity:${id}:alias`,{version:1,kind:"alias",issuer:proof.binding.issuer,subject:proof.cognitoSubject,googleKey,personId:google.person.id,createdAt:new Date(proof.now*1000).toISOString()},value=>value?.version===1 && value.kind==="alias" && value.issuer===proof.binding.issuer && value.subject===proof.cognitoSubject && value.googleKey===googleKey && value.personId===google.person.id));
    } catch(error) {
      if(error && typeof error==="object" && "code" in error && error.code==="identity_conflict" && record.state!=="committed")await this.write(`logins/${id}.json`,`identity:${id}:conflicted`,{...record,state:"conflicted"},stored.revision);
      throw error;
    }
    await this.step("person",()=>this.ensure(`people/${google.person.id}.json`,`identity:${id}:person`,{version:1,kind:"person",googleKey,person:google.person},value=>value?.version===1 && value.kind==="person" && value.googleKey===googleKey && hash(value.person)===hash(google.person)));
    await this.step("session",()=>this.ensure<SessionPointer>(`sessions/${googleKey}/${aliasKey}/${id}.json`,`identity:${id}:session`,{version:1,kind:"session",challengeId:id,googleKey,aliasKey,personId:google.person.id},value=>value?.version===1 && value.kind==="session" && value.challengeId===id && value.googleKey===googleKey && value.aliasKey===aliasKey && value.personId===google.person.id));
    if(record.state!=="committed")await this.step("complete",()=>this.write(`logins/${id}.json`,`identity:${id}:complete`,{...record,state:"committed",person:google.person} satisfies LoginRecord,stored.revision));
    return google.person;
  }
  private async committed(pointer:SessionPointer,google:GoogleRecord,aliasKey?:string,read:IdentityFiles["get"]=this.files.get.bind(this.files)):Promise<LoginRecord|null> {
    if(pointer?.version!==1 || pointer.kind!=="session" || pointer.personId!==google.person.id || pointer.googleKey!==googleIdentityKey(google.subject) || aliasKey && pointer.aliasKey!==aliasKey)return null;
    const login=(await read<LoginRecord>(`logins/${pointer.challengeId}.json`))?.value;
    if(!login || login.state!=="committed")return null;
    this.loginValid(login,pointer.challengeId);
    if(!login.proof || login.proof.googleSubject!==google.subject || cognitoAliasKey(login.proof.binding.issuer,login.proof.cognitoSubject)!==pointer.aliasKey || !sameBinding(login.proof.binding,login.challenge.binding) || hash(login.person)!==hash(google.person))fail(503,"identity_inconsistent","Committed enrollment links are inconsistent.");
    const alias=(await read<AliasRecord>(`aliases/${pointer.aliasKey}.json`))?.value;
    if(!alias || alias.googleKey!==pointer.googleKey || alias.personId!==pointer.personId || alias.issuer!==login.proof.binding.issuer || alias.subject!==login.proof.cognitoSubject)fail(503,"identity_inconsistent","Committed alias is inconsistent.");
    const person=(await read<{version:number;kind:string;googleKey:string;person:Person}>(`people/${google.person.id}.json`))?.value;
    if(!person || person.version!==1 || person.kind!=="person" || person.googleKey!==pointer.googleKey || hash(person.person)!==hash(google.person))fail(503,"identity_inconsistent","Committed Person lookup is incomplete.");
    return login;
  }
  async find(issuer:string,subject:string,_session?:IdentitySession) {
    // Immutable identity links are shared only within this lookup. Every later
    // request rereads canonical authority; no mutable account permissions cache.
    const reads=new Map<string,Promise<IdentityObject|null>>();
    const read:IdentityFiles["get"]=path=>{let pending=reads.get(path);if(!pending){pending=this.files.get(path);reads.set(path,pending);}return pending;};
    const aliasKey=cognitoAliasKey(issuer,subject);const alias=(await read<AliasRecord>(`aliases/${aliasKey}.json`))?.value;if(!alias)return null;
    if(alias.version!==1 || alias.kind!=="alias" || alias.issuer!==issuer || alias.subject!==subject)fail(503,"identity_inconsistent","Invalid canonical alias.");
    const google=(await read<GoogleRecord>(`google/${alias.googleKey}.json`))?.value;if(!google)fail(503,"identity_inconsistent","Missing Google identity.");
    this.checkGoogle(google,google.subject);
    if(alias.googleKey!==googleIdentityKey(google.subject) || alias.personId!==google.person.id)fail(503,"identity_inconsistent","Canonical alias conflicts.");
    const logins:LoginRecord[]=[];
    const paths=await this.files.list(`sessions/${alias.googleKey}/${aliasKey}/`);
    for(let offset=0;offset<paths.length;offset+=4) {
      const batch=await Promise.all(paths.slice(offset,offset+4).map(async path=>{
        const pointer=(await read<SessionPointer>(path))?.value;
        return pointer?this.committed(pointer,google,aliasKey,read):null;
      }));
      for(const login of batch)if(login)logins.push(login);
    }
    if(!logins.length)return null;
    return {person:google.person,alias:{issuer,subject,personId:google.person.id,googleIssuer:GOOGLE_ISSUER,googleSubject:google.subject,createdAt:alias.createdAt,provenance:logins.map(login=>login.proof!.binding),sessions:logins.map(login=>({binding:login.proof!.binding,authTime:login.proof!.authTime,lineageHash:login.proof!.lineageHash}))} satisfies GoogleAlias};
  }
  async getPerson(id:string):Promise<Person|null> {
    if(!UUID_PATTERN.test(id))return null;
    const pointer=(await this.files.get<{version:number;kind:string;googleKey:string;person:Person}>(`people/${id}.json`))?.value;if(!pointer)return null;
    const google=(await this.files.get<GoogleRecord>(`google/${pointer.googleKey}.json`))?.value;if(!google)return null;
    this.checkGoogle(google,google.subject);
    if(pointer.kind!=="person" || pointer.version!==1 || google.person.id!==id || hash(pointer.person)!==hash(google.person) || pointer.googleKey!==googleIdentityKey(google.subject))fail(503,"identity_inconsistent","Person pointer conflicts.");
    for(const path of await this.files.list(`sessions/${pointer.googleKey}/`)) {
      const session=(await this.files.get<SessionPointer>(path))?.value;if(session && await this.committed(session,google))return google.person;
    }
    return null;
  }
}
