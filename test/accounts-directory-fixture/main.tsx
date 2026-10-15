import React from "react";
import {createRoot} from "react-dom/client";
import {AccountsView} from "../../src/AccountsView";
import {accountsBrowser} from "../../src/accounts-client";
import "../../src/styles.css";
const mode=new URLSearchParams(location.search).get("mode");
const client=accountsBrowser(mode==="unconfigured"?undefined:"/directory-fixture",fetch,()=>"synthetic");
createRoot(document.getElementById("root")!).render(<AccountsView client={client} onConnect={async()=>{}}/>);
