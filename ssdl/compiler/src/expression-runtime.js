// One reviewed ExpressionAST/2 interpreter shared byte-for-byte by Node and browsers.
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('../generated/integer-codec.js'):root.SSEngineSSDLIntegerCodecV1);if(typeof module==='object'&&module.exports)module.exports=api;else root.SSEngineSSDLExpressionRuntime=api;})(typeof globalThis!=='undefined'?globalThis:this,function(codec){
'use strict';
const arities=Object.freeze({array:-1,not:1,equals:2,and:2,or:2,lt:2,gt:2,in:2,add:2,sub:2,mul:2,div:2,min:2,max:2,clamp:3,lerp:3,select:3});
function fail(code){const e=new Error(code);e.code=code;throw e;}
function same(a,b){if(a.type!==b.type||a.unit!==b.unit)fail('unit_mismatch');}
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
  if(op==='array'){if(a.some(x=>!['scalar','boolean','string'].includes(x.type)))fail('type_mismatch');for(const x of a.slice(1))same(a[0],x);return {type:'array',value:a,unit:a[0]?.unit??null,element_type:a[0]?.type??null};}
  if(['add','sub','mul','div','min','max'].includes(op)){scalar(a[0]);scalar(a[1]);return {...codec.numericBinary(op,a[0].value,a[0].unit,a[1].value,a[1].unit),type:'scalar'};}
  if(op==='not')return {value:!bool(a[0]),type:'boolean',unit:null};
  if(['equals','lt','gt'].includes(op)){same(a[0],a[1]);if(a[0].type==='array')fail('type_mismatch');if(op!=='equals')scalar(a[0]);return {value:op==='equals'?a[0].value===a[1].value:op==='lt'?a[0].value<a[1].value:a[0].value>a[1].value,type:'boolean',unit:null};}
  if(op==='in'){if(a[1].type!=='array'||!['scalar','boolean','string'].includes(a[0].type))fail('type_mismatch');if((instructions+=a[1].value.length)>maxInstructions)fail('expression_budget');for(const x of a[1].value)same(a[0],x);return {type:'boolean',unit:null,value:a[1].value.some(x=>x.value===a[0].value)};}
  scalar(a[0]);scalar(a[1]);scalar(a[2]);same(a[0],a[1]);
  if(op==='clamp'){same(a[0],a[2]);if(a[1].value>a[2].value)fail('invalid_range');return {...a[0],value:Math.max(a[1].value,Math.min(a[2].value,a[0].value))};}
  if(op==='lerp'){if(a[2].unit!=='scalar')fail('unit_mismatch');if(a[2].value<0||a[2].value>1000000)fail('invalid_range');const v=BigInt(a[0].value)+(BigInt(a[1].value)-BigInt(a[0].value))*BigInt(a[2].value)/1000000n;if(v>9007199254740991n||v< -9007199254740991n)fail('unsafe_integer');return {...a[0],value:Number(v)};}
  fail('unknown_operator');
 }
 return walk(expression,0);
}
return Object.freeze({evaluate,arities});
});
