import assert from 'node:assert/strict';
import {PARKS,parkRows,fountainRows,createParkController} from './park-motion.mjs';
for(let t=0;t<30;t+=.13){
 const rows=parkRows(t),walkers=Object.entries(rows).filter(([n])=>n.startsWith('walker')).flatMap(([,r])=>r.positions);
 assert.equal(walkers.length,72);assert.equal(rows.parkDrop,undefined);
 assert.equal(rows.parkBird0.positions.length+rows.parkBird1.positions.length,12);
 for(const p of walkers){
  const radius=Math.min(...PARKS.map(c=>Math.hypot(p[0]-c[0],p[1]-c[1])));
  assert.ok(Math.abs(radius-44)<1e-6||Math.abs(radius-46)<1e-6);assert.equal(p[2],.5);
 }
 const water=fountainRows(t);
 assert.equal(water.splash,undefined);assert.equal(water.ripple.positions.length,32);
 for(const [kind,r] of Object.entries(water))for(let i=0;i<r.positions.length;i++){
  const p=r.positions[i];assert.ok(p.every(Number.isFinite));
  assert.ok(Math.min(...PARKS.map(c=>Math.hypot(p[0]-c[0],p[1]-c[1])))<8);
  assert.ok(p[2]>=.72&&p[2]<1.5);assert.ok(r.scales_uniform[i]>0&&r.scales_uniform[i]<=10);
 }
 for(const r of Object.values(rows)){assert.equal(r.positions.length,r.rotations_z.length);assert.ok(r.positions.length<=512);}
}
function simulate(step){
 let time=0,writes=0;const data={},properties={};
 const api={instances:{set:(id,r)=>{assert.ok(Object.keys(r).every(k=>['positions','rotations_z','scales_uniform'].includes(k)));data[id]=r;writes++;},count:id=>data[id]?.positions.length??0},logical:{write:(k,v)=>properties[k]=v}};
 const c=createParkController(api,()=>time);c.tick({running:true});
 for(time=step;time<=1000;time+=step)c.tick({running:true});
 const before=JSON.stringify(data),count=writes;c.tick({running:false});time+=60000;c.tick({running:false});
 assert.equal(writes,count);assert.equal(JSON.stringify(data),before);
 c.tick({running:true});assert.equal(JSON.stringify(data),before);
 assert.equal(properties.parkVisitors,72);return data;
}
assert.deepEqual(simulate(50),simulate(50));
const a=simulate(50),b=simulate(100);
for(const id of Object.keys(a))for(let i=0;i<a[id].positions.length;i++)for(let j=0;j<3;j++)assert.ok(Math.abs(a[id].positions[i][j]-b[id].positions[i][j])<1e-8);
console.log('PASS: 72 visitors remain on paths; 12 birds; native particle water + 32 ripples; finite batches; pause/resume; elapsed-time invariance.');

// Steady 20 Hz park tick must submit fountain batches at 10 Hz, and never while paused.
let clock=0, waterWrites=0;
const controller=createParkController({instances:{set:(id)=>{if(id.startsWith('fountains__'))waterWrites++;},count:()=>9},logical:{write(){}}},()=>clock);
controller.tick({running:true});
for(clock=50;clock<=1000;clock+=50)controller.tick({running:true});
assert.equal(waterWrites,11); // initial ripple batch + ten updates
controller.tick({running:false});clock+=5000;controller.tick({running:false});
assert.equal(waterWrites,11);
console.log('PASS: fountain updates capped at 10 Hz; zero submissions while paused.');
