import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const binding=JSON.parse(readFileSync('SOURCE-SNAPSHOT.json'));
// source-styles.css is verified as an input. The build replaces root styles.css with its derived output.
for(const [path,digest] of Object.entries(binding.exportedFiles)){if(path==='styles.css')continue;assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),digest,'Source snapshot changed: '+path);}
console.log('Verified fixed public Client '+binding.sourceCommit+' (cn)');
