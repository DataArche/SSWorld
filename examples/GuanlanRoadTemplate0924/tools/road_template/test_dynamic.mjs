import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=path.join(root,'artifacts/guanlan-road-template');
const groups=JSON.parse(await fs.readFile(path.join(output,'furniture-rows.json'),'utf8'));
const expectedURL=pathToFileURL(path.join(output,'furniture-rows.json')).href;
const originalFetch=globalThis.fetch;
try {
  globalThis.fetch=async url=>{assert.equal(String(url),expectedURL);return {json:async()=>structuredClone(groups)}};
  const {createHostInterfaces}=await import(pathToFileURL(path.join(output,'logic.mjs')));
  const live=new Map();let calls=0;
  const {Furniture}=await createHostInterfaces({instances:{set(id,data){assert.ok(data.positions.length<=512);live.set(id,data);calls++;}}});
  const count=group=>Object.keys(groups[group]).reduce((n,id)=>n+(live.get(id)?.positions.length??0),0);
  const total=group=>Object.values(groups[group]).reduce((n,b)=>n+b.positions.length,0);
  assert.deepEqual(Object.keys(groups).sort(),['furniture','infill']);
  Furniture.sync({enabled:true,infill:true});assert.equal(count('furniture'),total('furniture'));assert.equal(count('infill'),total('infill'));const firstCalls=calls;
  Furniture.sync({enabled:true,infill:true});assert.equal(calls,firstCalls,'unchanged state must not rebuild GPU batches');
  Furniture.sync({enabled:false,infill:true});assert.equal(count('furniture'),0);assert.equal(count('infill'),total('infill'),'groups toggle independently');
  Furniture.sync({enabled:true,infill:false});assert.equal(count('furniture'),total('furniture'));assert.equal(count('infill'),0);
  Furniture.sync({enabled:true,infill:true});
  assert.deepEqual(Object.fromEntries(live),Object.assign({},...Object.values(groups)));
  console.log(JSON.stringify({ok:true,instances:{furniture:total('furniture'),infill:total('infill')},checks:['populate','idempotent','independent groups','restore exact transforms']}));
} finally {globalThis.fetch=originalFetch;}
