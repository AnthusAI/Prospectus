import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serverAccountsClient} from '../packages/accounts-client/src/server';

test('server SDK signs fresh ID evidence only on resolve and refreshes runtime credentials',async()=>{
 const requests: Array<{url:string;headers:Headers}>=[];let credentialCalls=0;
 const client=serverAccountsClient({endpoint:'https://accounts.example.invalid/api',region:'us-east-1',humanToken:()=> 'synthetic-access-proof',identityToken:()=> 'synthetic-id-proof',credentials:async()=>{credentialCalls++;return {accessKeyId:'synthetic-access',secretAccessKey:'synthetic-secret',sessionToken:'synthetic-session',expiration:new Date(Date.now()+600000)};},fetcher:async(url,init)=>{requests.push({url:String(url),headers:new Headers(init?.headers)});return new Response('{}');}});
 await client.challenge();await client.resolveGoogle('11111111-1111-4111-8111-111111111111');await client.directoryList();
 assert.equal(credentialCalls,3);
 assert.deepEqual(requests.map(request=>request.headers.get('x-prospectus-identity-token')),[null,'synthetic-id-proof',null]);
 for(const request of requests){assert.equal(request.headers.get('x-amz-security-token'),'synthetic-session');assert.match(request.headers.get('authorization')!,/x-prospectus-human-token/);}
 assert.match(requests[1].headers.get('authorization')!,/x-prospectus-identity-token/);
 assert.equal(requests[1].url,'https://accounts.example.invalid/api/v1/identities/google/resolve');
});

test('server SDK refuses static and expired credentials before transmitting evidence',async()=>{
 for(const credentials of [{accessKeyId:'synthetic',secretAccessKey:'synthetic'},{accessKeyId:'synthetic',secretAccessKey:'synthetic',sessionToken:'synthetic',expiration:new Date(0)}]){
  const client=serverAccountsClient({endpoint:'https://accounts.example.invalid',region:'us-east-1',humanToken:()=> 'synthetic-proof',credentials:async()=>credentials,fetcher:async()=>{throw Error('Must not transmit');}});
  await assert.rejects(client.directoryList(),/Runtime temporary credentials/);
 }
});
