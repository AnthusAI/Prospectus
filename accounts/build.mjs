import {build} from '../node_modules/esbuild/lib/main.js';
import {mkdir} from 'node:fs/promises';
for(const [entry,out] of [['accounts/canonical-lambda.ts','.artifacts/canonical-accounts'],['accounts/bff-lambda.ts','.artifacts/accounts-bff']]) {
 await mkdir(out,{recursive:true});await build({entryPoints:[entry],outfile:`${out}/index.js`,bundle:true,platform:'node',target:'node24',format:'cjs',logLevel:'info'});
}
