import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeFleet,sampleRoute,fleetRows,createTrafficController,ROAD_X,roadWidthX,rightLaneOffset,carBatchId,NIGHT_LENS_LEVEL} from './traffic-motion.mjs';
const fleet=makeFleet();
assert.equal(fleet.cars.length,351);
for(const route of fleet.routes){
  const start=sampleRoute(route,0),end=sampleRoute(route,route.length-1e-5);
  assert.ok(Math.hypot(start.position[0]-end.position[0],start.position[1]-end.position[1])<.001,'closed route seam');
  for(let d=0;d<route.length;d+=.5){
    const p=sampleRoute(route,d),q=sampleRoute(route,d+.01),[x,y]=p.position;
    const clearance=Math.max(...ROAD_X.map(rx=>roadWidthX(rx)/2-Math.abs(x-rx)),10-Math.abs(y+440),10-Math.abs(y-360));
    assert.ok(clearance>-.5,'centre stays in carriageway or rounded corner apron');
    const heading=Math.atan2(q.position[1]-y,q.position[0]-x)*180/Math.PI;
    const error=((heading-p.heading+540)%360)-180;
    assert.ok(Math.abs(error)<.1,'heading follows route tangent');
    assert.equal(p.position[2],.51);
  }
}
for(let i=0;i<6;i++){
  const r=fleet.routes[i];
  assert.equal(r.segments[0].a[0],ROAD_X[i]+rightLaneOffset(ROAD_X[i]));
  assert.equal(r.segments[4].a[0],ROAD_X[i+1]-rightLaneOffset(ROAD_X[i+1]));
  assert.equal(r.segments[2].a[1],352.5);
  assert.equal(r.segments[6].a[1],-432.5);
}
assert.equal(fleetRows(fleet,15).reduce((n,r)=>n+r.positions.length,0),351);
assert.notDeepEqual(fleetRows(fleet,0),fleetRows(fleet,15));
// The batch names the controller writes have to be the ones Traffic.ssdl declares; a rename on
// either side is otherwise a silent no-op that only shows up as cars that never appear.
{
  const declared=[...fs.readFileSync(new URL('./Traffic.ssdl',import.meta.url),'utf8')
    .matchAll(/Instances \{ id: (\w+)Batch/g)].map(m=>m[1]);
  assert.equal(declared.length,8,'four day car batches and four night twins, and no lens batches');
  for(let color=0;color<4;color++)for(const night of [false,true])
    assert.ok(declared.includes(carBatchId(color,night).replace('traffic__','').replace('Batch','')),
      `Traffic.ssdl declares ${carBatchId(color,night)}`);
}
function run(dt){
 let clock=0,updates=0;const batches=new Map(),props={};
 const api={instances:{set:(id,rows)=>{batches.set(id,rows);updates++;},count:id=>batches.get(id)?.positions.length||0},logical:{write:(k,v)=>props[k]=v}};
 const controller=createTrafficController(api,()=>clock,{update(){}});controller.tick({running:true});
 for(let t=0;t<2000;t+=dt){clock+=dt;controller.tick({running:true});}
 assert.equal([...batches.keys()].filter(id=>batches.get(id).positions.length).length,4,'daylight draws four batches, not twelve');
 const moving=structuredClone([...batches]);const before=updates;
 for(let i=0;i<50;i++){clock+=50;controller.tick({running:false});}
 assert.equal(updates,before,'paused cars do not rebuild or move');assert.deepEqual([...batches],moving);
 clock+=60_000;controller.tick({running:true});assert.deepEqual([...batches],moving,'resume does not jump over paused time');
 clock+=dt;controller.tick({running:true});assert.notDeepEqual([...batches],moving);
 assert.equal(props.movingCars,351);
 return moving;
}
// Dusk: the fleet changes over to the night twins, and does it even with traffic paused.
{
  const batches=new Map();let clock=0;
  const api={instances:{set:(id,rows)=>batches.set(id,{positions:rows.positions.slice()}),count:id=>batches.get(id)?.positions.length||0},logical:{write(){}}};
  const controller=createTrafficController(api,()=>clock,{update(){}});
  const live=()=>[...batches].filter(([,rows])=>rows.positions.length).map(([id])=>id).sort();
  controller.tick({running:true,lensLevel:0});
  assert.deepEqual(live(),[0,1,2,3].map(c=>carBatchId(c,false)),'day model while the lamps are out');
  clock+=100;controller.tick({running:false,lensLevel:NIGHT_LENS_LEVEL-1e-9});
  assert.deepEqual(live(),[0,1,2,3].map(c=>carBatchId(c,false)),'just under the threshold is still day');
  clock+=100;controller.tick({running:false,lensLevel:NIGHT_LENS_LEVEL});
  assert.deepEqual(live(),[0,1,2,3].map(c=>carBatchId(c,true)),'a paused queue still switches to the lit twin');
  const writes=batches.size;
  clock+=100;controller.tick({running:false,lensLevel:1});
  assert.equal(batches.size,writes,'a level that stays on the same side writes nothing new');
  clock+=100;controller.tick({running:false,lensLevel:0});
  assert.deepEqual(live(),[0,1,2,3].map(c=>carBatchId(c,false)),'and back at dawn');
  // Switching the PointLights off does not put the baked lenses out with them.
  clock+=100;controller.tick({running:false,lightLevel:0,lensLevel:1});
  assert.deepEqual(live(),[0,1,2,3].map(c=>carBatchId(c,true)),'lens glow follows the city lamps, not the vehicle-light toggle');
}

const a=run(50),b=run(100);
for(let k=0;k<4;k++)for(let i=0;i<a[k][1].positions.length;i++)for(let j=0;j<3;j++)assert.ok(Math.abs(a[k][1].positions[i][j]-b[k][1].positions[i][j])<1e-8,'elapsed time independent of tick rate');
console.log('PASS: 351 cars, continuous loops, road containment, tangent headings, day/night model switch, pause/resume, timestep invariance.');
