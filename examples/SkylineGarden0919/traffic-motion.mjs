// Local metres, +X east, +Y north. Cars face +X in their original GLB.
import {createVehiclePointLights} from './car-point-lights.mjs';
// Six clockwise, right-hand lane circuits follow the existing street grid.
export const ROAD_X = [-510,-350,-190,-30,130,290,450];
export const FLEET_SIZE = 351;
export const ROAD_Y = [-440,-280,-120,40,200,360];
export const roadWidthX=x=>x===-190||x===130?26:20;
export const rightLaneOffset=x=>roadWidthX(x)*.375;
export const SIGNAL_CYCLE = 36;
export function signalPhase(seconds) {
  const t=((seconds%SIGNAL_CYCLE)+SIGNAL_CYCLE)%SIGNAL_CYCLE;
  return t<12?0:t<15?1:t<18?2:t<30?3:t<33?4:5;
}
export function signalAllows(axis,seconds){return signalPhase(seconds)===axis*3;}
export function makeRoute(index) {
  // Four lanes: dashed dividers at +/-width/4, outer-lane centres at +/-3width/8.
  const x0=ROAD_X[index]+rightLaneOffset(ROAD_X[index]),x1=ROAD_X[index+1]-rightLaneOffset(ROAD_X[index+1]),y0=-440+7.5,y1=360-7.5,r=8;
  const segments=[];
  const line=(a,b)=>segments.push({kind:'line',a,b,length:Math.hypot(b[0]-a[0],b[1]-a[1])});
  const arc=(c,from)=>segments.push({kind:'arc',c,from,r,length:Math.PI*r/2});
  line([x0,y0+r],[x0,y1-r]);arc([x0+r,y1-r],Math.PI);
  line([x0+r,y1],[x1-r,y1]);arc([x1-r,y1-r],Math.PI/2);
  line([x1,y1-r],[x1,y0+r]);arc([x1-r,y0+r],0);
  line([x1-r,y0],[x0+r,y0]);arc([x0+r,y0+r],-Math.PI/2);
  const prefix=[];let length=0;
  for(const s of segments){prefix.push(length);length+=s.length;}
  const stops=[];
  for(const y of ROAD_Y.slice(1)){
    const at=y-(y===40?13:10)-12;
    stops.push({distance:at-(y0+r),axis:0,junction:[ROAD_X[index],y]});
  }
  for(const y of ROAD_Y.slice(0,-1)){
    const at=y+(y===40?13:10)+12;
    stops.push({distance:prefix[4]+(y1-r)-at,axis:0,junction:[ROAD_X[index+1],y]});
  }
  const east=ROAD_X[index+1],west=ROAD_X[index];
  stops.push({distance:prefix[2]+east-(east===-190||east===130?13:10)-12-(x0+r),axis:1,junction:[east,360]});
  stops.push({distance:prefix[6]+(x1-r)-(west+(west===-190||west===130?13:10)+12),axis:1,junction:[west,-440]});
  return {segments,length,stops:stops.sort((a,b)=>a.distance-b.distance)};
}
export function sampleRoute(route,distance) {
  let d=((distance%route.length)+route.length)%route.length;
  for(const s of route.segments){
    if(d>s.length){d-=s.length;continue;}
    if(s.kind==='line'){
      const t=d/s.length,dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1];
      return {position:[s.a[0]+dx*t,s.a[1]+dy*t,.51],heading:Math.atan2(dy,dx)*180/Math.PI};
    }
    const a=s.from-d/s.r;
    return {position:[s.c[0]+s.r*Math.cos(a),s.c[1]+s.r*Math.sin(a),.51],heading:(a-Math.PI/2)*180/Math.PI};
  }
  throw new Error('Route distance outside closed circuit');
}
export function makeFleet(){
  const routes=Array.from({length:6},(_,i)=>makeRoute(i)),cars=[];
  for(let ri=0;ri<routes.length;ri++){
    const count=ri<3?59:58;
    for(let i=0;i<count;i++)cars.push({route:ri,offset:(i+.31+ri*.07)*routes[ri].length/count,color:cars.length%4});
  }
  return {routes,cars};
}
export function fleetRows(fleet,seconds){
  const rows=Array.from({length:4},()=>({positions:[],rotations_z:[]}));
  for(const car of fleet.cars){
    const p=sampleRoute(fleet.routes[car.route],car.offset+seconds*8);
    rows[car.color].positions.push(p.position);rows[car.color].rotations_z.push(p.heading);
  }
  return rows;
}
// Each car has a day model and a night twin with its lens glow baked in. Below this level the
// lenses are dark enough to be worth nothing on screen; the switch is one batch swap, not a fade.
export const NIGHT_LENS_LEVEL=0.5;
export const carBatchId=(color,night)=>`traffic__car${color}${night?'Night':''}Batch`;
const EMPTY_ROWS={positions:[],rotations_z:[]};
export function createTrafficSimulation(){
  const fleet=makeFleet();
  for(const car of fleet.cars){car.distance=car.offset;car.speed=8;}
  const groups=Array.from({length:6},(_,r)=>fleet.cars.filter(c=>c.route===r));
  let ticks=0;
  return {
    fleet,
    get seconds(){return ticks*.05;},
    step(){
      const seconds=ticks*.05,next=[];
      for(const cars of groups){
        const route=fleet.routes[cars[0].route];
        for(let i=0;i<cars.length;i++){
          const car=cars[i],ahead=cars[(i+1)%cars.length];
          let gap=((ahead.distance-car.distance)%route.length+route.length)%route.length;
          let available=Math.max(0,gap-7.2);
          for(const stop of route.stops){
            if(signalAllows(stop.axis,seconds))continue;
            const relative=(stop.distance-car.distance)%route.length;
            // Include a car exactly on its stop point; a car already past clears.
            const distance=relative<-.000001?relative+route.length:Math.max(0,relative);
            available=Math.min(available,distance);
          }
          const desired=Math.min(8,Math.sqrt(2*3*available));
          const speed=desired<car.speed?Math.max(desired,car.speed-3*.05):Math.min(desired,car.speed+2*.05);
          const travel=Math.min(available,(car.speed+speed)*.5*.05);
          next.push([car,car.distance+travel,travel<.00001?0:speed]);
        }
      }
      for(const [car,distance,speed] of next){car.distance=distance;car.speed=speed;}
      ticks++;
    },
    rows(){
      const rows=Array.from({length:4},()=>({positions:[],rotations_z:[]}));
      for(const car of fleet.cars){
        const p=sampleRoute(fleet.routes[car.route],car.distance);
        rows[car.color].positions.push(p.position);rows[car.color].rotations_z.push(p.heading);
      }
      return rows;
    },
    get stopped(){return fleet.cars.filter(c=>c.speed<.1).length;}
  };
}
export function createTrafficController(api,now=()=>performance.now(),pointLights=createVehiclePointLights(api)){
  const simulation=createTrafficSimulation();let last=null,accumulator=0,initialized=false,lastReport=-Infinity,wasRunning=false;
  let cachedRows=null,night=null;
  return {
    tick({running,lightLevel=0,lensLevel=lightLevel}){
      const current=now();const dt=last===null?0:Math.min(.25,Math.max(0,(current-last)/1000));last=current;
      // Discard the pause transition interval; never catch up elapsed paused time.
      if(running&&wasRunning){
        accumulator+=dt;
        while(accumulator>=.05-1e-9){simulation.step();accumulator=Math.max(0,accumulator-.05);}
      }
      wasRunning=running;
      const lensNight=lensLevel>=NIGHT_LENS_LEVEL;
      // A standing queue still has to change over when the clock crosses dusk, so a lens switch is
      // reason enough to write the batches even while the fleet is paused.
      if(!initialized||running||lensNight!==night){
        const rows=simulation.rows(),seconds=simulation.seconds;
        cachedRows=rows;
        for(let i=0;i<4;i++)api.instances.set(carBatchId(i,lensNight),rows[i]);
        if(lensNight!==night){
          for(let i=0;i<4;i++)api.instances.set(carBatchId(i,!lensNight),EMPTY_ROWS);
          night=lensNight;
        }
        initialized=true;
        api.logical.write('signalPhase',signalPhase(seconds));
        if(seconds-lastReport>=.25||lastReport===-Infinity){
          api.logical.write('trafficSeconds',seconds);
          api.logical.write('stoppedCars',simulation.stopped);
          api.logical.write('movingCars',rows.reduce((n,_,i)=>n+api.instances.count(carBatchId(i,lensNight)),0));
          api.logical.write('leadCarX',rows[0].positions[0][0]);
          api.logical.write('leadCarY',rows[0].positions[0][1]);
          lastReport=seconds;
        }
      }
      pointLights.update(cachedRows,lightLevel);
    }
  };
}
