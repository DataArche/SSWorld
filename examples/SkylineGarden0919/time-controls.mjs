// A single clock writer keeps the astronomical sky and authored lights in sync.
export function clockWrite(day, offset, minutes) {
  const total = Math.round(Math.min(1440, Math.max(0, minutes))*60);
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCSeconds(total);
  return {sceneDateTime: date.toISOString().slice(0,19)+offset, timeOfDay: total/3600};
}
export function transitionValue(from, to, elapsed, duration) {
  const t = Math.min(1, Math.max(0, elapsed/duration));
  return from+(to-from)*t*t*(3-2*t);
}

export function mountTimeControls() {
  const slider=document.getElementById('time-slider');
  const output=document.getElementById('time-value');
  const dateLabel=document.getElementById('time-date');
  const dayButton=document.getElementById('day-preset');
  const nightButton=document.getElementById('night-preset');
  let day,offset,generation,current=840,transition=null,frame=0,busy=false,lastWrite=-Infinity;
  const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(Math.floor(m%60)).padStart(2,'0')}`;
  function show(minutes, moveSlider=true) {
    output.textContent=clock(minutes);
    if(moveSlider)slider.value=String(minutes);
    const night=minutes<390||minutes>=1065;
    dayButton.setAttribute('aria-pressed',String(!night));
    nightButton.setAttribute('aria-pressed',String(night));
    slider.dataset.transition=transition?'running':'idle';
  }
  function adopt() {
    const api=window.SSWorld?.logical;
    if(!api||document.body.dataset.runtime!=='ready')return;
    const state=api.read(),p=state.properties;
    if(!p||state.generation===generation)return;
    const match=/^(\d{4}-\d{2}-\d{2})T.*(Z|[+-]\d{2}:\d{2})$/.exec(p.sceneDateTime||'');
    if(!match)return;
    cancelAnimationFrame(frame);transition=null;
    generation=state.generation;day=match[1];offset=match[2]==='Z'?'+00:00':match[2];
    current=p.timeOfDay*60;
    // A 24:00 state belongs to the next ISO date; preserve the slider's base day.
    if(current===1440)day=new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    slider.disabled=false;show(current);
    dateLabel.textContent=day+' · UTC'+offset;
  }
  async function animate(now) {
    if(!transition)return;
    frame=requestAnimationFrame(animate);
    if(busy||now-lastWrite<50)return;
    const active=transition;
    const minutes=transitionValue(active.from,active.to,now-active.start,active.duration);
    busy=true;lastWrite=now;
    try {
      const writes=clockWrite(day,offset,minutes);
      await window.SSWorld.logical.writeBatch(writes);
      current=writes.timeOfDay*60;
      if(transition===active&&now-active.start>=active.duration){
        transition=null;cancelAnimationFrame(frame);
      }
      show(current,transition?.source!=='slider');
    } catch(error) {
      transition=null;cancelAnimationFrame(frame);show(current);
      dateLabel.textContent='时间调整失败：'+error.message;
    } finally {busy=false;}
  }
  function start(to,duration,source) {
    if(slider.disabled)return;
    const p=window.SSWorld.logical.read().properties;
    current=p.timeOfDay*60;
    cancelAnimationFrame(frame);
    transition={from:current,to,start:performance.now(),duration,source};
    slider.dataset.transition='running';
    frame=requestAnimationFrame(animate);
  }
  dayButton.onclick=()=>start(840,2500,'preset');
  nightButton.onclick=()=>start(1260,2500,'preset');
  slider.addEventListener('input',()=>start(Number(slider.value),250,'slider'));
  // A pointer or keyboard edit can retarget an in-progress preset immediately.
  slider.addEventListener('change',()=>start(Number(slider.value),250,'slider'));
  const poll=setInterval(adopt,300);adopt();
  window.addEventListener('beforeunload',()=>{clearInterval(poll);cancelAnimationFrame(frame);});
}
if(typeof document!=='undefined')mountTimeControls();
