import assert from 'node:assert/strict';
import {createVehiclePointLights,nearestCars,geodeticToEnu} from './car-point-lights.mjs';

const ANCHOR={lon:114.055,lat:22.533,height:20};

// The frame the cars are written in: the anchor itself is the origin, and a degree of longitude at
// this latitude is about 102.8 km of east.
{
  const here=geodeticToEnu(ANCHOR,ANCHOR.lon,ANCHOR.lat,ANCHOR.height);
  assert.ok(Math.hypot(here.x,here.y,here.z)<1e-6,'anchor maps to the local origin');
  const east=geodeticToEnu(ANCHOR,ANCHOR.lon+0.001,ANCHOR.lat,ANCHOR.height);
  assert.ok(Math.abs(east.y)<1e-3&&east.x>100&&east.x<106,'+longitude is +x east');
  const north=geodeticToEnu(ANCHOR,ANCHOR.lon,ANCHOR.lat+0.001,ANCHOR.height);
  assert.ok(Math.abs(north.x)<1e-3&&north.y>110&&north.y<112,'+latitude is +y north');
}

{
  const cars=[{at:[30,0,0]},{at:[10,0,0]},{at:[20,0,0]},{at:[0,40,0]}];
  assert.deepEqual(nearestCars(cars,{x:0,y:0},2),[1,2],'nearest two by ground distance');
  assert.deepEqual(nearestCars(cars,{x:0,y:0},9),[0,1,2,3],'a budget wider than the fleet keeps every car');
  assert.deepEqual(nearestCars(cars,{x:40,y:0},2),[0,2],'ranking follows the camera');
}

const FLEET=351,BUDGET=48;
function rowsAt(positions){
  return [{positions,rotations_z:positions.map(()=>0)},
    {positions:[],rotations_z:[]},{positions:[],rotations_z:[]},{positions:[],rotations_z:[]}];
}
function lineFleet(){return Array.from({length:FLEET},(_,i)=>[i*10,0,0.51]);}

function harness({missing=()=>[]}={}){
  const calls={spawn:0,set:[],positions:[]};
  const api={
    anchor:ANCHOR,
    cameraGeodetic:()=>({longitude:ANCHOR.lon,latitude:ANCHOR.lat,height:ANCHOR.height}),
    carLightPositions:(updates)=>{calls.positions.push(updates.map(u=>u.id));return missing(updates);},
    scene:{
      list:()=>[],
      spawn:(name,params,placement)=>{calls.spawn++;return {handle:'fragment/'+placement.tag};},
      set:(handle,property,value)=>calls.set.push([handle,property,value]),
    },
  };
  return {api,calls,lights:createVehiclePointLights(api)};
}

// One light per car exists, but only the budget is ever lit or moved.
{
  const {calls,lights}=harness();
  lights.update(rowsAt(lineFleet()),1);
  assert.equal(calls.spawn,FLEET,'a fragment per car');
  assert.equal(calls.set.filter(([,,value])=>value>0).length,BUDGET,'only the budget is lit');
  assert.equal(calls.set.filter(([,,value])=>value===0).length,0,'a fresh fragment is already dark; no write to keep it dark');
  assert.equal(calls.set.length,BUDGET,'the 303 unlit cars cost no native write at all');
  assert.equal(calls.positions.length,1);
  assert.deepEqual(calls.positions[0],Array.from({length:BUDGET},(_,i)=>`fragment/car-light:0:${i}/fragment-root__front`),
    'the budget is the cars nearest the camera');
  assert.equal(calls.set.filter(([,,value])=>value===0.25).length,BUDGET,'PointLight level is a quarter of lampLevel');
}

// A tick that changes nothing costs nothing; sub-5-cm creep still costs nothing.
{
  const {calls,lights}=harness();
  const fleet=lineFleet();
  lights.update(rowsAt(fleet),1);
  const spawned=calls.spawn,sets=calls.set.length;
  lights.update(rowsAt(fleet),1);
  assert.equal(calls.positions.length,1,'a still fleet is not rewritten');
  assert.equal(calls.set.length,sets);assert.equal(calls.spawn,spawned);
  fleet[0]=[fleet[0][0]+0.01,0,0.51];
  lights.update(rowsAt(fleet),1);
  assert.equal(calls.positions.length,1,'1 cm of creep stays under the epsilon');
  fleet[0]=[fleet[0][0]+1,0,0.51];
  lights.update(rowsAt(fleet),1);
  assert.deepEqual(calls.positions.at(-1),['fragment/car-light:0:0/fragment-root__front'],'only the car that moved is written');
}

// A fragment the facade could not resolve is retried on the next tick, and only that one.
{
  let refuse=true;
  const {calls,lights}=harness({missing:(updates)=>refuse?[updates[3].id]:[]});
  const fleet=lineFleet();
  lights.update(rowsAt(fleet),1);
  refuse=false;
  lights.update(rowsAt(fleet),1);
  assert.deepEqual(calls.positions[1],['fragment/car-light:0:3/fragment-root__front'],'only the unresolved id comes back');
  lights.update(rowsAt(fleet),1);
  assert.equal(calls.positions.length,2,'once it lands it stops coming back');
}

// Dark means dark: no positions are written at all, and the lit set is put out first.
{
  const {calls,lights}=harness();
  const fleet=lineFleet();
  lights.update(rowsAt(fleet),1);
  const writes=calls.positions.length;
  lights.update(rowsAt(fleet),0);
  assert.equal(calls.positions.length,writes,'a dark fleet writes no positions');
  assert.equal(calls.set.filter(([,,value])=>value===0).length,BUDGET,'the lit budget is put out');
  // ...and comes back lit, with its position restored: a level write reapplies the authored one.
  lights.update(rowsAt(fleet),1);
  assert.equal(calls.positions.at(-1).length,BUDGET,'relighting rewrites every budget position');
}

// Dusk: lampLevel creeps while a queue stands still. The level write reapplies the fragment's
// AUTHORED position, so every light it touched has to be placed again in the same round or it
// jumps to the car's origin and stays there.
{
  const {calls,lights}=harness();
  const fleet=lineFleet();
  lights.update(rowsAt(fleet),1);
  const writes=calls.positions.length;
  lights.update(rowsAt(fleet),0.9);
  assert.equal(calls.set.filter(([,,value])=>value===0.225).length,BUDGET,'the budget takes the new level');
  assert.equal(calls.positions.length,writes+1,'a level change costs one position round');
  assert.equal(calls.positions.at(-1).length,BUDGET,'every light whose level was written is placed again');
}

// A light that leaves the budget goes dark; the one that replaced it is lit and placed.
{
  const camera={longitude:ANCHOR.lon,latitude:ANCHOR.lat,height:ANCHOR.height};
  const calls={set:[],positions:[]};
  const api={
    anchor:ANCHOR,cameraGeodetic:()=>camera,
    carLightPositions:(updates)=>{calls.positions.push(updates.map(u=>u.id));return [];},
    scene:{list:()=>[],spawn:(n,p,placement)=>({handle:'fragment/'+placement.tag}),
      set:(handle,property,value)=>calls.set.push([handle,property,value])},
  };
  const lights=createVehiclePointLights(api);
  const fleet=lineFleet();
  lights.update(rowsAt(fleet),1);
  calls.set.length=0;calls.positions.length=0;
  // Drag the camera 243 m east along the line of cars: car 0 falls out of the nearest 48 (243 m)
  // behind cars 1..48 (233..237 m), and car 48 takes its place.
  camera.longitude=ANCHOR.lon+243/102790;
  lights.update(rowsAt(fleet),1);
  const dark=calls.set.filter(([,,value])=>value===0).map(([handle])=>handle);
  const lit=calls.set.filter(([,,value])=>value>0).map(([handle])=>handle);
  assert.deepEqual(dark,['fragment/car-light:0:0'],'the car the camera left behind goes dark');
  assert.deepEqual(lit,[`fragment/car-light:0:${BUDGET}`],'the car it reached is lit');
  assert.ok(calls.positions.at(-1).includes(`fragment/car-light:0:${BUDGET}/fragment-root__front`),
    'a newly lit light is placed in the same round its level was written');
}

console.log(`PASS: ${BUDGET}-light camera budget, 5 cm write epsilon, queued-fragment retry, blackout and budget handover.`);
