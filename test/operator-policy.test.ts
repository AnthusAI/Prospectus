import {test} from "node:test";
import assert from "node:assert/strict";
import {operatorGrants,canReadOperatorDirectory} from "../accounts/operator-policy";
import type {Context} from "../accounts/model";
import deployedGrants from "../accounts/operator-grants.json";
const context:Context={product:"prospectus-directory",principal:"arn:aws:iam::111111111111:role/Synthetic",human:{issuer:"https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic",subject:"synthetic-operator"},capabilities:["console:read","members:read"]};
const grant={product:context.product,issuer:context.human.issuer,subject:context.human.subject,permission:"accounts:admin:read",reviewedGrantId:"synthetic-approval-v1"};
test("operator permission requires an exact deployment-owned human grant and no production grant ships",()=>{
 assert.deepEqual(deployedGrants,[]);assert.equal(canReadOperatorDirectory(context,operatorGrants([])),false);
 const policy=operatorGrants([grant]);assert.equal(canReadOperatorDirectory(context,policy),true);
 for(const changed of [{...context,product:"other"},{...context,human:{...context.human,issuer:context.human.issuer+"other"}},{...context,human:{...context.human,subject:"other"}}])assert.equal(canReadOperatorDirectory(changed,policy),false);
 grant.subject="changed-after-validation";assert.equal(canReadOperatorDirectory(context,policy),true);
});
test("malformed or ambiguous operator grants fail closed",()=>{
 for(const value of [null,{},[{}],[{...grant,reviewedGrantId:""}],[{...grant,permission:"accounts:admin:write"}],[{...grant,email:"operator@example.invalid"}],[grant,grant]])assert.throws(()=>operatorGrants(value));
});
