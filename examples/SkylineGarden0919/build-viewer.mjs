import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const template=fs.readFileSync(path.join(root,'viewer-template.html'),'utf8');
let head=template.slice(0,template.indexOf('<body')).replace('lang="en"','lang="zh-CN"');
let scripts='<script type="module" src="./time-controls.mjs"></script>\n'+template.slice(template.indexOf('  <script type="module">'));
scripts=scripts.replace('snapshot: () => host.snapshotGeneration("ssworld-project"),','snapshot: () => host.snapshotGeneration("ssworld-project"),\n            recallView: () => bridge.graph.get("cityView").writeCamera(),');
scripts=scripts.replace('    import { SceneModuleHost }', '    import { startFpsMeter } from "./fps-meter.mjs";\n    import { SceneModuleHost }');
scripts=scripts.replace('      const canvas = await waitForRenderCanvas();', '      const canvas = await waitForRenderCanvas();\n      startFpsMeter(window.GlobalViewer, engineConfig);');
const shell=`<body data-runtime="loading">
<div id="screen" aria-label="山水都会三维城市"></div>
<header><a class="brand" href="#">S<span>G</span></a><div class="identity"><div>SSWORLD / URBAN STUDY 019</div><h1>山水都会 <span>SKYLINE GARDEN</span></h1></div><span class="live"><i></i> 实时三维</span></header>
<div id="fps-panel" data-level="waiting" title="引擎帧循环 FPS，每 0.5 秒平均；帧间隔非 GPU 耗时" aria-label="实时帧率"><div><strong id="fps-value">—</strong><span>FPS</span></div><small id="frame-ms">采样中</small></div>\n<aside class="intro"><p class="eyebrow">A CITY BETWEEN WATER & HILLS</p><h2>城市向上生长<br>生活向绿延伸。</h2><p>高楼、街巷与山水之间，<br>一座可以自由探索的概念城市。</p><div class="stats"><div><b>194</b><span>建筑</span></div><div><b>30</b><span>街区地块</span></div><div><b>1.6 km</b><span>设计范围</span></div></div><button id="layout-toggle" aria-expanded="false">▦ 查看设计布局</button><button id="reference-toggle" aria-expanded="false">◧ 对照参考图</button></aside>
<section class="view-label"><span id="view-number">01 / 05</span><h3 id="view-title">山水全景</h3><p id="view-caption">商务核心 · 街区公园 · 河谷山地</p></section>
<nav class="toolbar" aria-label="城市探索"><div class="view-buttons"><button data-view="0" aria-pressed="true">01 <span>山水全景</span></button><button data-view="1" aria-pressed="false">02 <span>设计总图</span></button><button data-view="2" aria-pressed="false">03 <span>商务核心</span></button><button data-view="3" aria-pressed="false">04 <span>街区漫游</span></button><button data-view="4" aria-pressed="false">05 <span>公园生活</span></button></div><div class="tools"><button id="reset-view">↺ 复位</button><button id="traffic-toggle" aria-pressed="true">Ⅱ 暂停交通</button><button id="park-toggle" aria-pressed="true">Ⅱ 暂停公园</button><button id="vehicle-light-toggle" aria-pressed="true" title="控制车前灯点光照明，保留车灯自发光">车辆光源：开</button></div></nav>
<section class="time-panel"><label for="time-slider">昼夜时刻 <output id="time-value">14:00</output></label><input id="time-slider" type="range" min="0" max="1440" step="1" value="840" aria-label="日光时间" disabled><div><span>00:00</span><span>12:00</span><span>24:00</span></div><div class="day-night"><button id="day-preset" aria-pressed="true">☀ 白昼</button><button id="night-preset" aria-pressed="false">☾ 夜晚</button></div><span id="time-date" hidden></span></section>
<dialog id="layout-panel"><button class="close" aria-label="关闭布局">×</button><img src="layout.svg" alt="设计布局：中央商务区、南侧低层街区、中央公园与北侧河道"><p>蓝色：商务核心　米色：低层街区　绿色：公园　深灰：道路<br>北侧山水 / 南侧轨道 / 东侧高架 · 设计尺度，非实测城市</p></dialog>
<dialog id="reference-panel"><button class="close" aria-label="关闭参考图">×</button><img src="reference.png" alt="用户提供的城市参考图"><p>单张参考图的概念设计 · 未校准真实尺寸<br>保留高低错落的楼群、道路层次与外围山水，街区布局重新设计。</p></dialog>
<footer><span>左键拖动平移 · 右键拖动转向 · 滚轮缩放</span><span>概念城市 / 设计尺度 <i></i> SSEngine WebGPU</span></footer>
<div class="runtime-fields"><span id="status"></span><span id="generation"></span><span id="last-batch"></span><span id="logical-state"></span><span id="hint"></span></div>
<div id="loading">正在唤醒城市<span>加载地形、建筑与街道…</span></div>
<script>
const titles=['山水全景','设计总图','商务核心','街区漫游','公园生活'];
const captions=['商务核心 · 街区公园 · 河谷山地','路网与地块 · 建筑密度 · 蓝绿空间','玻璃塔楼 · 双地标 · 高低错落的天际线','斑马线 · 红绿灯 · 车辆排队通行','环形步道 · 花园廊架 · 行人、喷泉与飞鸟'];
let currentView=0;
document.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>{
 if(!window.SSWorld?.logical)return;
 const mode=Number(btn.dataset.view);currentView=mode;
 if(window.SSWorld.logical.read().properties.viewMode===mode)window.SSWorld.recallView();else window.SSWorld.logical.write('viewMode',mode);
 document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));
 document.getElementById('view-number').textContent='0'+(mode+1)+' / 05';
 document.getElementById('view-title').textContent=titles[mode];document.getElementById('view-caption').textContent=captions[mode];
}));
document.getElementById('reset-view').onclick=()=>document.querySelector('[data-view="'+currentView+'"]').click();
document.getElementById('traffic-toggle').onclick=e=>{if(!window.SSWorld?.logical)return;const next=!window.SSWorld.logical.read().properties.trafficRunning;window.SSWorld.logical.write('trafficRunning',next);e.currentTarget.textContent=next?'Ⅱ 暂停交通':'▷ 运行交通';e.currentTarget.setAttribute('aria-pressed',String(next));};
document.getElementById('park-toggle').onclick=e=>{if(!window.SSWorld?.logical)return;const next=!window.SSWorld.logical.read().properties.parkRunning;window.SSWorld.logical.write('parkRunning',next);e.currentTarget.textContent=next?'Ⅱ 暂停公园':'▷ 运行公园';e.currentTarget.setAttribute('aria-pressed',String(next));};
document.getElementById('vehicle-light-toggle').onclick=()=>{if(!window.SSWorld?.logical)return;window.SSWorld.logical.write('vehicleLightsEnabled',!window.SSWorld.logical.read().properties.vehicleLightsEnabled);syncVehicleLights();};
function syncVehicleLights(){const enabled=window.SSWorld?.logical?.read().properties.vehicleLightsEnabled;const button=document.getElementById('vehicle-light-toggle');button.disabled=typeof enabled!=='boolean';if(typeof enabled==='boolean'){button.textContent=enabled?'车辆光源：开':'车辆光源：关';button.setAttribute('aria-pressed',String(enabled));}}
syncVehicleLights();setInterval(syncVehicleLights,500);
for(const name of ['layout','reference']){const d=document.getElementById(name+'-panel');document.getElementById(name+'-toggle').onclick=()=>{d.showModal();document.getElementById(name+'-toggle').setAttribute('aria-expanded','true');};d.querySelector('.close').onclick=()=>d.close();d.addEventListener('close',()=>document.getElementById(name+'-toggle').setAttribute('aria-expanded','false'));}
setInterval(()=>{const ready=document.body.dataset.runtime==='ready';document.getElementById('loading').hidden=ready;if(document.body.dataset.runtime==='error')document.getElementById('loading').textContent='加载未完成，请查看运行状态并刷新。';},500);
</script>
`;
fs.writeFileSync(path.join(root,'index.html'),head+shell+scripts);
