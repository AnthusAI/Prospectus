import {readFileSync} from "node:fs";
import {papyrusSiteRegistrations} from "./papyrus-sites";
import {membershipLookupMode} from "./durable-accounts";
export function accountsDeployment() {
 const config=JSON.parse(readFileSync(new URL("./deployment.json",import.meta.url),"utf8"));
 if(config.enabled===false)return null;
 if(config.enabled!==true || config.storageMode!=="canonical-virtuus-v1" || !/^[A-Za-z0-9._:-]{1,128}$/.test(config.googlePolicyReviewId??""))throw new Error("Canonical accounts activation requires reviewed storage and Google policy ID.");
 membershipLookupMode(config.membershipLookup);
 const consoleConfig=JSON.parse(readFileSync(new URL("./console-deployment.json",import.meta.url),"utf8"));
 if(typeof consoleConfig.clientEnabled!=="boolean" || typeof consoleConfig.pairEnabled!=="boolean" || (consoleConfig.pairEnabled && !consoleConfig.clientEnabled) || consoleConfig.federationReviewId!=="cyclotron-google-only-unlinked-v1-20261015" || consoleConfig.pairReviewId!=="cyclotron-execution-pair-v1-20261015")throw new Error("Console activation requires the exact reviewed client and principal pair.");
 return {consoleClientEnabled:consoleConfig.clientEnabled,consolePairEnabled:consoleConfig.pairEnabled,consoleFederationReviewId:consoleConfig.federationReviewId as string,consolePairReviewId:consoleConfig.pairReviewId as string,googlePolicyReviewId:config.googlePolicyReviewId as string,papyrusSites:papyrusSiteRegistrations(JSON.parse(readFileSync(new URL("./papyrus-sites.json",import.meta.url),"utf8")))};
}
