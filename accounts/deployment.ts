import {readFileSync} from "node:fs";
export function accountsDeployment() {
 const config=JSON.parse(readFileSync(new URL("./deployment.json",import.meta.url),"utf8"));
 if(config.enabled===false)return null;
 if(config.enabled!==true || config.storageMode!=="canonical-virtuus-v1" || !/^[A-Za-z0-9._:-]{1,128}$/.test(config.googlePolicyReviewId??""))throw new Error("Canonical accounts activation requires reviewed storage and Google policy ID.");
 return {googlePolicyReviewId:config.googlePolicyReviewId as string};
}
