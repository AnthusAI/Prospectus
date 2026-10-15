import React, { useId } from "react";
import type { AccountSummary } from "./client.js";
export interface AccountSwitcherProps {
  accounts: readonly AccountSummary[];
  selectedAccountId: string | null;
  onSelect: (accountId: string) => void;
  disabled?: boolean;
  error?: string;
}
/** Selection is a host preference, never an authorization grant. */
export function AccountSwitcher({accounts,selectedAccountId,onSelect,disabled,error}:AccountSwitcherProps) {
  const id=useId();
  const selected=accounts.some(account=>account.id === selectedAccountId)?selectedAccountId!:"";
  return <div className="prospectus-account-switcher"><label htmlFor={id}>Account</label>
    <select id={id} value={selected} disabled={disabled || accounts.length === 0} aria-describedby={error?`${id}-error`:undefined}
      onChange={event=>{if(accounts.some(account=>account.id === event.target.value)) onSelect(event.target.value);}}>
      <option value="">{accounts.length?"Choose an account":"No accounts available"}</option>
      {accounts.map(account=><option key={account.id} value={account.id}>{account.name} · {account.role}</option>)}
    </select>{error && <p id={`${id}-error`} role="alert">{error}</p>}
  </div>;
}
