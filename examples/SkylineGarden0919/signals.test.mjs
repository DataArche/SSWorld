import assert from 'node:assert/strict';
import {createTrafficSimulation,signalPhase,signalAllows,createTrafficController} from './traffic-motion.mjs';

assert.deepEqual([0,12,15,18,30,33,36].map(signalPhase),[0,1,2,3,4,5,0]);
for(let t=0;t<72;t+=.05)assert.ok(!(signalAllows(0,t)&&signalAllows(1,t)),'conflicting directions never green together');
const sim=createTrafficSimulation();let crossings=0,maxStopped=0,departures=0;
for(let frame=0;frame<7200;frame++){
  const before=sim.fleet.cars.map(c=>({distance:c.distance,speed:c.speed})),time=sim.seconds;
  sim.step();maxStopped=Math.max(maxStopped,sim.stopped);
  for(let i=0;i<sim.fleet.cars.length;i++){
    const car=sim.fleet.cars[i],prev=before[i],route=sim.fleet.routes[car.route];
    const travel=car.distance-prev.distance;
    assert.ok(travel>=-1e-8&&travel<=.400001,'bounded forward travel');
    if(prev.speed<=.1&&car.speed>.1)departures++;
    for(const stop of route.stops){
      const distance=((stop.distance-prev.distance)%route.length+route.length)%route.length;
      if(travel>1e-6&&distance<travel-1e-6){
        assert.ok(signalAllows(stop.axis,time),`red-light crossing at ${time}, axis ${stop.axis}`);crossings++;
      }
    }
  }
  for(let r=0;r<6;r++){
    const cars=sim.fleet.cars.filter(c=>c.route===r),length=sim.fleet.routes[r].length;
    for(let i=0;i<cars.length;i++){
      const gap=((cars[(i+1)%cars.length].distance-cars[i].distance)%length+length)%length;
      assert.ok(gap>=7.2-1e-6,'queue maintains minimum centre spacing');
    }
  }
}
assert.ok(crossings>100&&maxStopped>20&&departures>100,'vehicles queue, cross and depart repeatedly');
function controllerRun(dt){
  let now=0;const props={},batches=new Map();
  const c=createTrafficController({instances:{set:(k,v)=>batches.set(k,v),count:k=>batches.get(k)?.positions.length??0},logical:{write:(k,v)=>props[k]=v}},()=>now,{update(){}});
  c.tick({running:true});
  for(let t=0;t<42000;t+=dt){now+=dt;c.tick({running:true});}
  const saved=structuredClone({props,batches:[...batches]});
  now+=20000;c.tick({running:false});now+=20000;c.tick({running:true});
  assert.deepEqual({props,batches:[...batches]},saved,'pause freezes signals and queues without resume catchup');
  return saved;
}
assert.deepEqual(controllerRun(50),controllerRun(100),'fixed-step traffic and signals independent of host tick rate');
console.log(`PASS: 360 s; ${crossings} legal crossings; ${departures} queue departures; max ${maxStopped} stopped; headway, phases, pause and timestep checks.`);
