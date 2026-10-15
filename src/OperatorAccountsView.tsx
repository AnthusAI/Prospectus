import {useEffect,useRef,useState} from "react";
import type {OperatorReader,OperatorList,OperatorDetail} from "../packages/accounts-client/src/directory";

/** Read-only operator surface; its transport independently enforces the central permission. */
export function OperatorAccountsView({client,allowed}:{client:OperatorReader;allowed:boolean}) {
 const [data,setData]=useState<OperatorList|null>(null);
 const [selected,setSelected]=useState<OperatorDetail|null>(null);
 const [loading,setLoading]=useState(false);
 const [detailLoading,setDetailLoading]=useState(false);
 const [error,setError]=useState("");
 const [detailError,setDetailError]=useState("");
 const [reload,setReload]=useState(0);
 const request=useRef(0);
 useEffect(()=>{
  let current=true;request.current++;setData(null);setSelected(null);setError("");setDetailError("");setDetailLoading(false);
  if(!allowed){setLoading(false);return;}
  setLoading(true);
  void client.operatorList().then(value=>{if(current)setData(value);}).catch(()=>{if(current)setError("Account administration could not be loaded. Your permission may have changed. Refresh to try again.");}).finally(()=>{if(current)setLoading(false);});
  return()=>{current=false;request.current++;};
 },[client,allowed,reload]);
 async function open(id:string) {
  const sequence=++request.current;setSelected(null);setDetailLoading(true);setDetailError("");
  try{const value=await client.operatorDetail(id);if(sequence===request.current)setSelected(value);}
  catch{if(sequence===request.current)setDetailError("Organization details are unavailable or administrator access has changed.");}
  finally{if(sequence===request.current)setDetailLoading(false);}
 }
 return <section aria-label="Account administration">
  <div className="accounts-heading"><div><h3>Account administration</h3><p>All organizations, product entitlements and memberships. Administrator access is read-only and does not make you a member of these organizations.</p></div>{allowed && <button className="accounts-action quiet" disabled={loading} onClick={()=>setReload(value=>value+1)}>Refresh directory</button>}</div>
  {!allowed?<p role="status">An explicitly assigned central Accounts administrator permission is required. CRM administrator status does not grant this access.</p>:<>
   {loading && <p role="status">Loading organization directory…</p>}
   {error && <p role="alert">{error}</p>}
   {data?.accounts.length===0 && <p role="status">No organizations have been created in the central account directory.</p>}
   {!!data?.accounts.length && <div className="accounts-columns"><section aria-label="All organizations"><ul className="account-list">{data.accounts.map(account=><li key={account.id}><button className="account-choice" aria-pressed={selected?.id===account.id} onClick={()=>void open(account.id)}><strong>{account.name}</strong><span>{account.activeMembers} active members</span><span>{account.products.map(product=>`${product.product} · ${product.status}`).join(", ") || "No product entitlements"}</span></button></li>)}</ul></section><section aria-label="Organization details" aria-busy={detailLoading}>
    {detailLoading?<p role="status">Loading organization details…</p>:detailError?<p role="alert">{detailError}</p>:selected?<>
     <h4>{selected.name}</h4><dl><dt>Account ID</dt><dd className="account-id">{selected.id}</dd><dt>Created</dt><dd>{new Date(selected.createdAt).toLocaleDateString()}</dd><dt>Revision</dt><dd>{selected.revision}</dd></dl>
     <h4>Organization entitlements</h4>{selected.entitlements.length?<ul>{selected.entitlements.map(entitlement=><li key={entitlement.product}>{entitlement.product} · {entitlement.status}<p>Capabilities: {entitlement.capabilities.join(", ") || "None"}</p></li>)}</ul>:<p>No product entitlements.</p>}
     <h4>Organization memberships</h4><ul>{selected.memberships.map(member=><li key={member.personId}><span className="account-id">{member.personId}</span> · {member.role} · {member.status}</li>)}</ul>
    </>:<p>Select an organization to see details.</p>}
   </section></div>}
  </>}
 </section>;
}
