// Count engine update callbacks, not an independent browser requestAnimationFrame loop.
export function startFpsMeter(viewer,engine){
  const panel=document.getElementById('fps-panel'),value=document.getElementById('fps-value'),timing=document.getElementById('frame-ms');
  let start=0,count=0,last=performance.now(),active=true;
  function reset(){start=0;count=0;value.textContent='—';timing.textContent=document.hidden?'后台暂停':'采样中';panel.dataset.level='waiting';}
  function frame(){
    const now=performance.now();last=now;
    if(document.hidden||document.body.dataset.runtime!=='ready'){start=0;count=0;return;}
    if(!start){start=now;return;}
    count++;
    const elapsed=now-start;
    if(elapsed<500)return;
    const fps=count*1000/elapsed;
    value.textContent=fps.toFixed(1);timing.textContent=(elapsed/count).toFixed(1)+' ms / 帧';
    panel.dataset.level=fps>=50?'good':fps>=30?'medium':'low';
    start=now;count=0;
  }
  if(typeof viewer?._addEventListener!=='function'||typeof engine?.addFunction!=='function'){
    timing.textContent='帧率接口不可用';return;
  }
  const pointer=engine.addFunction(frame,'vd');
  let event;
  try{event=viewer._addEventListener('update',pointer);}catch(error){engine.removeFunction(pointer);timing.textContent='帧率接口不可用';return;}
  document.addEventListener('visibilitychange',reset);
  const watchdog=setInterval(()=>{
    if(document.hidden||document.body.dataset.runtime!=='ready'){reset();return;}
    if(performance.now()-last>1500){value.textContent='0.0';timing.textContent='等待渲染';panel.dataset.level='low';start=0;count=0;}
  },500);
  window.addEventListener('pagehide',()=>{if(!active)return;active=false;clearInterval(watchdog);document.removeEventListener('visibilitychange',reset);viewer.removeEventListener(event);},{once:true});
}
