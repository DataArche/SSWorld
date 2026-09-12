
const R=Math.PI/180;
const seeds=[[0,12,2.3],[-7,22,2.8],[6,22,2.3],[-10,36,3],[9,36,2.7],[1,36,3.5]];
const obstacles=[[-13.5,-6.5,10.5,13.5,2],[8,12,15,21,3.2],...([[-6,0],[8,3],[-13,25],[6,32]].map(([x,y])=>[x-1.2,x+1.2,y-.9,y+.9,1.4]))];
export function createHostInterfaces(api) {
 window.__duskCleanup?.();
 const abort=new AbortController(), keys=new Set();
 const on=(el,e,f)=>el.addEventListener(e,f,{signal:abort.signal,capture:true});
 const hud=document.createElement('div');hud.id='dusk-ui';
 hud.innerHTML=`<style>
 .panel,.status{display:none!important} body{margin:0;overflow:hidden;background:#101918;display:block!important} #screen{position:absolute!important;inset:0;width:100%;height:100%}
 #dusk-ui{position:fixed;inset:0;pointer-events:none;color:#eee9d6;font:14px/1.5 "Segoe UI","Microsoft Yahei",sans-serif;z-index:30}
 #dusk-ui *{box-sizing:border-box}.top{position:absolute;top:28px;left:32px;right:32px;display:flex;justify-content:space-between;align-items:flex-start}
 .brand{font-size:25px;letter-spacing:5px;font-weight:800}.eyebrow2{font-size:10px;letter-spacing:4px;color:#e2b36f;margin-bottom:7px}
 .sub{font-size:11px;color:#c1cec5;letter-spacing:2px}.stats{display:flex;gap:30px;background:#0f2026c9;padding:12px 24px;border-top:2px solid #e1b276;backdrop-filter:blur(8px)}
 .stat small{display:block;letter-spacing:2px;font-size:10px;color:#a7bbb5}.stat strong{font-size:28px;font-weight:500;font-variant-numeric:tabular-nums}
 #cross{position:absolute;top:50%;left:50%;width:26px;height:26px;transform:translate(-50%,-50%);filter:drop-shadow(0 1px 2px black)}
 #cross:before,#cross:after{content:"";position:absolute;background:#f3e9cb}#cross:before{width:2px;height:26px;left:12px}#cross:after{height:2px;width:26px;top:12px}
 #cross.hit:before,#cross.hit:after{background:#ffb344}#cross.hit{transform:translate(-50%,-50%) rotate(45deg)}
 #notice{position:absolute;top:57%;width:100%;text-align:center;font-weight:700;letter-spacing:3px;color:#ffd08c;text-shadow:0 2px 5px #000}
 .bottom{position:absolute;bottom:26px;left:32px;right:32px;display:flex;justify-content:space-between;align-items:end}
 .controls{background:#0e2028b8;border-left:2px solid #a7b6a1;padding:12px 18px;font-size:11px;line-height:2;color:#ced7cb}
 kbd{color:#f5d8a8;padding-right:5px;font:inherit;font-weight:bold}.ammo{text-align:right}.ammo b{font-size:46px;font-weight:400}.ammo small{color:#b3c8c2;letter-spacing:2px}
 #menu{pointer-events:auto;position:absolute;left:7%;top:27%;max-width:470px;padding:34px 38px;background:linear-gradient(120deg,#101f25f2,#12272bdc);border:1px solid #65797177;border-left:3px solid #e7b879;backdrop-filter:blur(12px);box-shadow:0 20px 100px #0006}
 #menu h1{font-size:42px;line-height:1.12;letter-spacing:2px;margin:14px 0 18px}#menu p{font-size:13px;color:#c0ccc4;line-height:1.9}#menu button{cursor:pointer;background:#e5bb80;color:#172929;padding:14px 30px;border:0;font-weight:800;letter-spacing:2px;margin-top:15px;font-size:14px}
 #menu .tag{font-size:10px;letter-spacing:3px;color:#e3b77a}#weapon{position:absolute;right:20%;bottom:-50px;width:86px;height:240px;background:linear-gradient(90deg,#182122,#78807a 18%,#2d3839 32%,#131f24 68%,#5b6460);border:3px solid #131d20;transform:rotate(-14deg);border-radius:15px 15px 3px 3px;box-shadow:14px 0 0 #243436}
 #weapon:before{content:"";position:absolute;left:23px;top:-68px;width:26px;height:90px;background:linear-gradient(90deg,#111c20,#78887e,#1a2a2b);border:3px solid #152025;border-radius:4px}
 #weapon:after{content:"";position:absolute;top:8px;left:20px;width:40px;height:30px;border:5px solid #0f181b;background:#8daf9944;border-radius:6px}
 #weapon.fire{filter:brightness(1.8);bottom:-62px}#flash{display:none;position:absolute;bottom:210px;right:23%;width:46px;height:65px;background:#ffe5a0;clip-path:polygon(50% 0,65% 35%,100% 15%,76% 65%,100% 100%,44% 80%,0 100%,20% 50%,0 20%);filter:drop-shadow(0 0 20px orange)}
 #flash.on{display:block}#timebar{position:absolute;top:0;left:0;height:3px;background:#e8bc7a;width:100%}
 @media(max-width:800px){.top{left:18px;right:18px;top:18px}.stats{gap:14px;padding:8px 12px}.brand{font-size:18px}.stat strong{font-size:22px}#menu{top:23%;left:6%;max-width:400px;padding:22px}#menu h1{font-size:32px}.bottom{left:18px;right:18px;bottom:18px}.controls{font-size:10px}}
 </style>
 <div id="timebar"></div><div class="top"><div><div class="eyebrow2">FIELD OPERATIONS / 07</div><div class="brand">暮林行动</div><div class="sub">DUSK RANGE · 林地训练营</div></div><div class="stats"><div class="stat"><small>得分 SCORE</small><strong id="score">0000</strong></div><div class="stat"><small>剩余 TIME</small><strong id="time">75.0</strong></div><div class="stat"><small>连击 COMBO</small><strong id="combo">×0</strong></div></div></div>
 <div id="cross"></div><div id="notice"></div><div id="weapon"></div><div id="flash"></div>
 <div class="bottom"><div class="controls"><kbd>W A S D</kbd> 移动　<kbd>鼠标 / 方向键</kbd> 瞄准<br><kbd>左键 / 空格</kbd> 射击　<kbd>右键 / Q</kbd> 倍镜　<kbd>R</kbd> 换弹　<kbd>Esc</kbd> 暂停</div><div class="ammo"><small id="reload">CARBINE / 12 ROUNDS</small><br><b id="ammo">12</b><small> / ∞</small></div></div>
 <section id="menu"><div class="tag">75 SECONDS · SIX MOVING TARGETS</div><h1>暮色降临。<br>保持准心。</h1><p id="summary">穿行于林地训练营，击倒橙色移动靶。<br>靶心 +150，外环 +100；连续命中叠加奖励。<br>12 发弹匣，换弹需要 1.4 秒。挑战 3000 分！</p><button id="start">开始行动 →</button> <button id="keyboard" style="background:transparent;color:#e5bb80;border:1px solid #e5bb8088;padding:12px">键盘模式</button><p style="font-size:10px;margin-bottom:0">点击进入鼠标瞄准 · 也可使用方向键</p></section>`;
 document.body.append(hud);
 const $=id=>hud.querySelector('#'+id);
 let s,paused=true,started=false,ended=false,clock=0,last=performance.now(),cool=0,reloading=0,feedback=0,flash=0;
 let tx=seeds.map(v=>v[0]),respawn=Array(6).fill(0),lastHit=-100;
 const reset=()=>{s={px:0,py:-18,heading:0,pitch:1,zoom:78,score:0,ammo:12,remaining:75,combo:0,shots:0,hits:0,playing:false,clock:0};clock=0;cool=0;reloading=0;respawn.fill(0);tx=seeds.map(v=>v[0]);lastHit=-100;ended=false;};
 reset();
 const sync=()=>{let batch={...s,clock,playing:started&&!paused&&!ended};for(let i=0;i<6;i++){batch['tx'+i]=tx[i];batch['alive'+i]=respawn[i]<=0;}Object.entries(batch).forEach(([name,value])=>api.logical.write(name,value));};
 const show=(t,d)=>{$('menu').style.display='block';$('summary').innerHTML=d;$('start').textContent=t;};
 const pause=()=>{if(!started||ended)return;paused=true;keys.clear();s.zoom=78;show('继续行动 →','行动已暂停。<br>点击继续，计时和靶标移动将恢复。');};
 const begin=(lock=true)=>{if(!started||ended){reset();started=true;}paused=false;ended=false;$('menu').style.display='none';last=performance.now();if(lock)document.body.requestPointerLock?.()?.catch(()=>{});sync();};
 on($('start'),'click',e=>{e.stopPropagation();begin();});
 on($('keyboard'),'click',e=>{e.stopPropagation();begin(false);});
 const reload=()=>{if(!paused&&!ended&&s.ammo<12&&reloading<=0){reloading=1.4;$('notice').textContent='更换弹匣';}};
 function rayBox(dir,b,maxT){
  let lo=0,hi=maxT;const p=[s.px,s.py,1.8],mn=[b[0],b[2],0],mx=[b[1],b[3],b[4]];
  for(let j=0;j<3;j++){if(Math.abs(dir[j])<1e-7){if(p[j]<mn[j]||p[j]>mx[j])return false;}else{let a=(mn[j]-p[j])/dir[j],c=(mx[j]-p[j])/dir[j];if(a>c)[a,c]=[c,a];lo=Math.max(lo,a);hi=Math.min(hi,c);if(lo>hi)return false;}}return hi>0;
 }
 function fire(){
  if(paused||ended||!started||cool>0||reloading>0)return;
  if(s.ammo<=0){$('notice').textContent='弹匣空了 · 按 R 换弹';feedback=1;return;}
  s.ammo--;s.shots++;cool=.18;flash=.075;
  const h=s.heading*R,p=s.pitch*R,dir=[Math.sin(h)*Math.cos(p),Math.cos(h)*Math.cos(p),Math.sin(p)];
  let best=-1,dist=Infinity,bull=false;
  for(let i=0;i<6;i++){
   if(respawn[i]>0||Math.abs(dir[1])<1e-6)continue;
   let t=(seeds[i][1]-.18-s.py)/dir[1];if(t<=0||t>dist)continue;
   let dx=s.px+dir[0]*t-tx[i],dz=1.8+dir[2]*t-seeds[i][2],r=Math.hypot(dx,dz);
   if(r<=.77&&!obstacles.some(b=>rayBox(dir,b,t))){best=i;dist=t;bull=r<.21;}
  }
  if(best>=0){s.combo=clock-lastHit<3.5?s.combo+1:1;lastHit=clock;s.hits++;let points=(bull?150:100)+Math.min(10,s.combo-1)*20;s.score+=points;respawn[best]=1.5;feedback=.55;$('notice').textContent=(bull?'靶心命中':'命中')+' +'+points;$('cross').classList.add('hit');}
  else{s.combo=0;feedback=.35;$('notice').textContent='未命中';}
  sync();
 }
 on(window,'keydown',e=>{
  if(e.target instanceof HTMLButtonElement&&e.key==='Enter')return;
  const k=e.key.toLowerCase();if(['w','a','s','d','q','r',' ','arrowleft','arrowright','arrowup','arrowdown','escape','enter','shift'].includes(k)){e.preventDefault();e.stopImmediatePropagation();}
  keys.add(k);if(e.repeat)return;
  if(k==='escape'){pause();document.exitPointerLock?.();}
  else if(k==='enter'&&paused)begin();else if(k==='r')reload();else if(k===' ')fire();else if(k==='q'&&!paused)s.zoom=s.zoom===78?42:78;
 });
 on(window,'keyup',e=>keys.delete(e.key.toLowerCase()));
 on(window,'blur',()=>keys.clear());
 on(document,'visibilitychange',()=>{if(document.hidden)pause();});
 on(document,'pointerlockchange',()=>{if(!document.pointerLockElement&&!paused&&started&&!ended)pause();});
 on(window,'contextmenu',e=>{e.preventDefault();});
 on(window,'mousemove',e=>{
  if(paused||!started||ended)return;
  if(document.pointerLockElement){s.heading+=e.movementX*.10;s.pitch=Math.max(-35,Math.min(35,s.pitch-e.movementY*.10));}
 });
 on(window,'mousedown',e=>{
  if(e.target.closest?.('#menu'))return;
  if(!started||paused||ended)return;
  e.preventDefault();e.stopImmediatePropagation();
  if(e.button===0)fire();if(e.button===2)s.zoom=42;
 });
 on(window,'mouseup',e=>{if(e.button===2)s.zoom=78;});
 function tick(){
  const now=performance.now(),dt=Math.min(.08,Math.max(0,(now-last)/1000));last=now;
  if(!paused&&started&&!ended){
   clock+=dt;s.remaining=Math.max(0,s.remaining-dt);cool=Math.max(0,cool-dt);
   if(reloading>0){reloading-=dt;if(reloading<=0){s.ammo=12;$('notice').textContent='弹匣就绪';feedback=.45;}}
   if(keys.has('arrowleft'))s.heading-=65*dt;if(keys.has('arrowright'))s.heading+=65*dt;
   if(keys.has('arrowup'))s.pitch=Math.min(35,s.pitch+40*dt);if(keys.has('arrowdown'))s.pitch=Math.max(-35,s.pitch-40*dt);
   const f=Number(keys.has('w'))-Number(keys.has('s')),r=Number(keys.has('d'))-Number(keys.has('a')),len=Math.hypot(f,r)||1;
   const speed=(keys.has('shift')?6:4)*dt/len,h=s.heading*R;
   const dx=(Math.sin(h)*f+Math.cos(h)*r)*speed,dy=(Math.cos(h)*f-Math.sin(h)*r)*speed;
   const free=(x,y)=>!obstacles.some(b=>x>b[0]-.35&&x<b[1]+.35&&y>b[2]-.35&&y<b[3]+.35);
   let x=Math.max(-16.5,Math.min(16.5,s.px+dx));if(free(x,s.py))s.px=x;
   let y=Math.max(-23,Math.min(42,s.py+dy));if(free(s.px,y))s.py=y;
   for(let i=0;i<6;i++){respawn[i]=Math.max(0,respawn[i]-dt);tx[i]=seeds[i][0]+Math.sin(clock*(.65+i*.12)+i)* (i===0?2.1:2.8);}
   if(clock-lastHit>3.5)s.combo=0;
   if(s.remaining<=0){ended=true;paused=true;s.playing=false;let accuracy=s.shots?Math.round(s.hits/s.shots*100):0;show('再来一局 →','本局得分 <b>'+s.score+'</b> · '+(s.score>=3000?'训练精英':'继续挑战 3000 分')+'<br>命中 '+s.hits+' / '+s.shots+' · 命中率 '+accuracy+'%');document.exitPointerLock?.();}
  }
  if(feedback>0){feedback-=dt;if(feedback<=0){$('notice').textContent='';$('cross').classList.remove('hit');}}
  flash=Math.max(0,flash-dt);$('weapon').classList.toggle('fire',flash>0);$('flash').classList.toggle('on',flash>0);
  $('score').textContent=String(s.score).padStart(4,'0');$('time').textContent=s.remaining.toFixed(1);$('combo').textContent='×'+s.combo;$('ammo').textContent=String(s.ammo).padStart(2,'0');
  $('reload').textContent=reloading>0?'RELOADING · '+Math.max(0,reloading).toFixed(1)+'s':'CARBINE / 12 ROUNDS';$('timebar').style.width=s.remaining/75*100+'%';
  sync();
 }
 window.__duskCleanup=()=>{abort.abort();hud.remove();};
 return {Game:{tick}};
}
