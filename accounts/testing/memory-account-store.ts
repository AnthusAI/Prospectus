import { Conflict, type Check, type Entry, type Key, type TransactionStore, type Write } from "../store";
/** Single-process account fixture; not a proposed canonical membership backend. */
export class MemoryAccountStore implements TransactionStore {
 private rows=new Map<string,Entry>();
 private id(key:Key){return JSON.stringify([key.pk,key.sk]);}
 async get<T=any>(key:Key):Promise<Entry<T>|null>{return structuredClone(this.rows.get(this.id(key)) ?? null);}
 async query<T=any>(pk:string,prefix:string):Promise<Entry<T>[]>{return structuredClone([...this.rows.values()].filter(row=>row.pk===pk && row.sk.startsWith(prefix)));}
 async transact(writes:Write[],checks:Check[]=[]):Promise<void>{
  for(const check of [...writes,...checks])if((this.rows.get(this.id(check))?.version ?? null)!==check.version)throw new Conflict();
  for(const write of writes)this.rows.set(this.id(write),{pk:write.pk,sk:write.sk,value:structuredClone(write.value),version:(write.version??0)+1});
 }
 get count(){return this.rows.size;}
}
