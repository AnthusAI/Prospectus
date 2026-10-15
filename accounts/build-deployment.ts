import {execFileSync} from 'node:child_process';
import {accountsDeployment} from './deployment';
// Disabled integration must not add native packaging work to routine CRM deploys.
if(accountsDeployment()) {
 execFileSync('npm',['run','build:accounts'],{stdio:'inherit'});
 execFileSync('bash',['scripts/build-accounts-linux.sh'],{stdio:'inherit'});
 execFileSync('node',['accounts/package-smoke.mjs'],{stdio:'inherit'});
} else console.log('Accounts activation disabled; preserving the existing CRM-only deployment.');
