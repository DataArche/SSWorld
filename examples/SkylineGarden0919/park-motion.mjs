export const PARKS=[[-430,280],[-110,-40],[50,-40],[370,-200]];
export function parkRows(t){
  // Stabilize discrete gait frames across equivalent timer subdivisions.
  t=Math.round(t*1e6)/1e6;
  const rows=Object.fromEntries([...Array.from({length:8},(_,i)=>'walker'+i),'parkBird0','parkBird1'].map(n=>[n,{positions:[],rotations_z:[]}]));
  const put=(name,p,yaw=0)=>{rows[name].positions.push(p);rows[name].rotations_z.push(yaw);};
  for(const [pi,[cx,cy]] of PARKS.entries()){
    for(let i=0;i<18;i++){
      const dir=i%2?1:-1,r=dir===1?44:46,speed=i%3===0?1.65:1.15;
      const a=i*Math.PI*2/18+dir*t*speed/r+pi*.2;
      const gait=Math.floor(t*(i%3===0?6:4)+i)%4;
      put('walker'+((i%2)*4+gait),[cx+r*Math.cos(a),cy+r*Math.sin(a),.5],(a+dir*Math.PI/2)*180/Math.PI);
    }
    for(let i=0;i<3;i++){
      const a=t*.19+i*Math.PI*2/3+pi,r=23+i*4;
      put('parkBird'+(Math.floor(t*5+i)%2),[cx+r*Math.cos(a),cy+r*Math.sin(a),14+i*2+Math.sin(t+i)],(a+Math.PI/2)*180/Math.PI);
    }

  }
  return rows;
}
export function createParkController(api,now=()=>performance.now()){
  let last=null,t=0,initialized=false,wasRunning=false,report=-Infinity,fountainFrame=-1;
  return {tick({running}){
    const current=now(),dt=last===null?0:Math.max(0,Math.min(.25,(current-last)/1000));last=current;
    if(running&&wasRunning)t+=dt;wasRunning=running;
    if(!initialized||running){
      const rows=parkRows(t);
      for(const [n,r] of Object.entries(rows))api.instances.set('parklife__'+n+'Batch',r);
      // Native emitters own the water simulation; only 32 surface rings update here.
      const frame=Math.floor((t+1e-7)*10);
      if(frame!==fountainFrame){
        const water=fountainRows(frame/10);
        api.instances.set('fountains__rippleBatch',water.ripple);
        fountainFrame=frame;
      }
      initialized=true;
      if(t-report>=.25){
        api.logical.write('parkSeconds',t);
        api.logical.write('parkVisitors',Array.from({length:8},(_,i)=>api.instances.count('parklife__walker'+i+'Batch')).reduce((a,b)=>a+b,0));
        const lead=Object.entries(rows).find(([n,r])=>n.startsWith('walker')&&r.positions.length)[1].positions[0];
        api.logical.write('walkerX',lead[0]);report=t;
      }
    }
  }};
}

export function fountainRows(t){
  const ripple={positions:[],scales_uniform:[]};
  for(const [pi,[cx,cy]] of PARKS.entries()){
    for(let i=0;i<8;i++){
      const a=i*Math.PI/4, u=(t*.8+i*.381+pi*.17)%1, r=.16+.95*u;
      ripple.positions.push([cx+6.3*Math.cos(a),cy+6.3*Math.sin(a),.725]);
      ripple.scales_uniform.push(r);
    }
  }
  return {ripple};
}
