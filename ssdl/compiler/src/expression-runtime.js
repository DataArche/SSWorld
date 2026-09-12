// One reviewed ExpressionAST/2 interpreter shared byte-for-byte by Node and browsers.
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('../generated/integer-codec.js'):root.SSEngineSSDLIntegerCodecV1);if(typeof module==='object'&&module.exports)module.exports=api;else root.SSEngineSSDLExpressionRuntime=api;})(typeof globalThis!=='undefined'?globalThis:this,function(codec){
'use strict';
const arities=Object.freeze({array:-1,not:1,equals:2,and:2,or:2,lt:2,gt:2,in:2,add:2,sub:2,mul:2,div:2,min:2,max:2,clamp:3,lerp:3,select:3,abs:1,sign:1,floor:1,ceil:1,round:1,mod:2,sqrt:1,hypot:2,sin:1,cos:1,atan2:2,hash01:1});
function fail(code){const e=new Error(code);e.code=code;throw e;}
const MICRO=1000000n;
function unitDivisor(unit){const d=codec.PROFILE.literal_divisors[unit];if(d===undefined)fail('unit_mismatch');return BigInt(d);}
// Integer square root (Newton). Fixed point is linear in the divisor, so hypot/sqrt of raw
// micro-integers lands back in the same fixed point without ever touching a float.
function isqrt(n){if(n<0n)fail('invalid_range');if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;}
function finite(value){if(!Number.isFinite(value))fail('unsafe_integer');return codec.safeInteger(Math.trunc(value));}
// Deterministic 32-bit avalanche (splitmix-style finalizer). Bindings re-evaluate every frame and the
// runtime verifies its own readback, so a real random() would fail that invariant and jitter every
// pixel gate; hash01 gives per-seed variety that is stable across frames, reloads and machines.
function hash01(raw){let x=BigInt.asUintN(32,BigInt(raw)+0x9e3779b9n);x=BigInt.asUintN(32,(x^(x>>16n))*0x7feb352dn);x=BigInt.asUintN(32,(x^(x>>15n))*0x846ca68bn);x=BigInt.asUintN(32,x^(x>>16n));return Number(x*MICRO/4294967296n);}
// Units are tags, not dimensions, and nothing here rescales by one.  Every value this interpreter sees
// comes from the 0.3 compiler, whose typeSpec() keys the fixed-point divisor off value_type alone --
// so a duration and a length are both micro-units and a mixed pair is already in one lane.  (The 0.2
// compiler rejects mismatched units statically, so its literal_divisors never reach this path either.)
// Mixing therefore means exactly "take the numbers at face value"; the tag only decides which unit the
// result is labelled with, which is what the binding write-back reads.
function laneUnit(a,b){return a.unit==='scalar'?b.unit:a.unit;}
function align(a,b){if(a.type!==b.type)fail('type_mismatch');return [a,b];}
function same(a,b){if(a.type!==b.type)fail('type_mismatch');}
function scalar(v){if(v.type!=='scalar')fail('type_mismatch');codec.safeInteger(v.value);return v;}
function bool(v){if(v.type!=='boolean')fail('type_mismatch');return v.value;}
function evaluate(expression,resolve=()=>fail('unknown_reference'),{maxInstructions=16384,maxDepth=48}={}){
 let instructions=0;
 function walk(e,depth){
  if(++instructions>maxInstructions)fail('expression_budget');if(depth>maxDepth)fail('depth_budget');
  if(!e||typeof e!=='object'||Array.isArray(e))fail('invalid_expression');
  if(Object.hasOwn(e,'literal')){
   if(Object.keys(e).some(k=>!['literal','unit'].includes(k)))fail('invalid_expression');
   const type=typeof e.literal;if(type==='number'){codec.safeInteger(e.literal);if(!Object.hasOwn(codec.PROFILE.literal_divisors,e.unit||'scalar'))fail('unit_mismatch');return {value:e.literal,type:'scalar',unit:e.unit||'scalar'};}
   if(e.unit!==undefined||!(type==='string'||type==='boolean'||e.literal===null))fail('type_mismatch');
   if(type==='string'&&(!e.literal.isWellFormed()||e.literal.length>4096))fail('invalid_literal');
   return {value:e.literal,type:e.literal===null?'null':type,unit:null};
  }
  if(e.ref){if(Object.keys(e).length!==1)fail('invalid_expression');const r=e.ref;if(r.root!=='node'||r.channel!=='logical'||!Array.isArray(r.segments)||r.segments.length!==2||Object.keys(r).some(k=>!['root','segments','channel'].includes(k)))fail('binding_rate_unsupported');const v=resolve(r);if(v.type==='scalar')scalar(v);return v;}
  if(Object.keys(e).length!==2||!Object.hasOwn(arities,e.op)||!Array.isArray(e.args)||(e.op==='array'?e.args.length>256:e.args.length!==arities[e.op]))fail('invalid_expression');
  const op=e.op;
  // Compilation validates all branch types and dependencies. Evaluation is short-circuit.
  if(op==='select'){const condition=bool(walk(e.args[0],depth+1));return walk(e.args[condition?1:2],depth+1);}
  if(op==='and'||op==='or'){const first=bool(walk(e.args[0],depth+1));return {type:'boolean',unit:null,value:op==='and'?(first?bool(walk(e.args[1],depth+1)):false):(first?true:bool(walk(e.args[1],depth+1)))};}
  const a=e.args.map(x=>walk(x,depth+1));
  if(op==='array'){if(a.some(x=>!['scalar','boolean','string'].includes(x.type)))fail('type_mismatch');for(const x of a.slice(1))same(a[0],x);const unit=a.reduce((u,x)=>u==='scalar'&&x.type==='scalar'?x.unit:u,a[0]?.unit??null);const items=a[0]?.type==='scalar'?a.map(x=>({...x,unit})):a;return {type:'array',value:items,unit:items[0]?.unit??null,element_type:items[0]?.type??null};}
  if(['add','sub','mul','div','min','max'].includes(op)){scalar(a[0]);scalar(a[1]);return {...codec.numericBinary(op,a[0].value,a[0].unit,a[1].value,a[1].unit),type:'scalar'};}
  if(op==='not')return {value:!bool(a[0]),type:'boolean',unit:null};
  if(['equals','lt','gt'].includes(op)){const [p,q]=align(a[0],a[1]);if(p.type==='array')fail('type_mismatch');if(op!=='equals')scalar(p);return {value:op==='equals'?p.value===q.value:op==='lt'?p.value<q.value:p.value>q.value,type:'boolean',unit:null};}
  if(op==='in'){if(a[1].type!=='array'||!['scalar','boolean','string'].includes(a[0].type))fail('type_mismatch');if((instructions+=a[1].value.length)>maxInstructions)fail('expression_budget');for(const x of a[1].value)same(a[0],x);return {type:'boolean',unit:null,value:a[1].value.some(x=>{const [p,q]=align(a[0],x);return p.value===q.value;})};}
  if(['abs','sign','floor','ceil','round','sqrt','sin','cos','hash01'].includes(op)){
   scalar(a[0]);const v=BigInt(a[0].value),unit=a[0].unit;
   if(op==='abs')return {type:'scalar',unit,value:codec.safeInteger(Number(v<0n?-v:v))};
   if(op==='sign')return {type:'scalar',unit:'scalar',value:Number(v<0n?-MICRO:v>0n?MICRO:0n)};
   if(op==='hash01')return {type:'scalar',unit:'scalar',value:hash01(a[0].value)};
   if(op==='sqrt'){if(v<0n)fail('invalid_range');return {type:'scalar',unit,value:codec.safeInteger(Number(isqrt(v*MICRO)))};}
   // rad is radians; every other lane reads as degrees, because SSDL authors write degrees everywhere
   // else (sunAzimuth, rotation) and sin(90) === 1 is what they mean.
   if(op==='sin'||op==='cos'){const radians=unit==='rad'?Number(v)/1e6:Number(v)/1e6*Math.PI/180;return {type:'scalar',unit:'scalar',value:finite((op==='sin'?Math.sin(radians):Math.cos(radians))*1e6)};}
   const d=MICRO;const q=v/d,r=v%d;let n=q;
   if(op==='floor')n=r<0n?q-1n:q;else if(op==='ceil')n=r>0n?q+1n:q;else{const twice=(r<0n?-r:r)*2n;n=twice>=d?(v<0n?q-1n:q+1n):q;}
   return {type:'scalar',unit,value:codec.safeInteger(Number(n*d))};
  }
  if(op==='mod'||op==='hypot'||op==='atan2'){
   scalar(a[0]);scalar(a[1]);const [p,q]=align(a[0],a[1]);const x=BigInt(p.value),y=BigInt(q.value);
   if(op==='mod'){if(y===0n)fail('division_by_zero');return {type:'scalar',unit:p.unit,value:codec.safeInteger(Number(x%y))};}
   if(op==='hypot')return {type:'scalar',unit:p.unit,value:codec.safeInteger(Number(isqrt(x*x+y*y)))};
   return {type:'scalar',unit:'deg',value:finite(Math.atan2(Number(x),Number(y))*180/Math.PI*1e6)};
  }
  scalar(a[0]);scalar(a[1]);scalar(a[2]);
  if(op==='clamp'){if(a[1].value>a[2].value)fail('invalid_range');return {...a[0],value:Math.max(a[1].value,Math.min(a[2].value,a[0].value))};}
  if(op==='lerp'){const t=a[2];if(t.value<0||t.value>1000000)fail('invalid_range');const p=a[0],q={...a[1],unit:laneUnit(a[0],a[1])};const v=BigInt(p.value)+(BigInt(q.value)-BigInt(p.value))*BigInt(t.value)/1000000n;if(v>9007199254740991n||v< -9007199254740991n)fail('unsafe_integer');return {...p,value:Number(v)};}
  fail('unknown_operator');
 }
 return walk(expression,0);
}
return Object.freeze({evaluate,arities});
});
