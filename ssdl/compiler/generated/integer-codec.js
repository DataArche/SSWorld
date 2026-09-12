// Generated from tools/templates/ssdl_integer_codec_v1.js.in. DO NOT EDIT.
(function(root,factory){ const api=factory(); if(typeof module==='object'&&module.exports) module.exports=api; else root.SSEngineSSDLIntegerCodecV1=api; })(typeof globalThis!=='undefined'?globalThis:this, function(){
'use strict';
const PROFILE = {"schema_version":"SSDLIntegerCodec/1","safe_integer_max":9007199254740991,"literal_divisors":{"scalar":1000000,"m":1000000,"rad":1000000,"deg":1000000,"ms":1},"decimal_token_max_bytes":4096,"decimal_exponent_abs_max":4096,"decimal_rounding":"reject_inexact","division_rounding":"toward_zero","scratch_arithmetic":"exact_unbounded_result_safe_integer","box_center":"baseZ_um + trunc(height_um / 2)","box_center_tolerance_nm":500,"positive_dimensions":true,"scalar_um_components":["value_um"],"vec3_um_components":["x_um","y_um","z_um"]};
const PROFILE_DIGEST = 'sha256:f5974b65fd52ea20e2a88d3c7ef8a81d14c11832d88edab374112ef4505209f3';
const LIMIT=9007199254740991n;
const fail=code=>{throw new Error(code);};
function safeInteger(value) { if(typeof value!=='number'||!Number.isSafeInteger(value)) fail('unsafe_integer'); return value; }
function result(value) { if(value < -LIMIT || value > LIMIT) fail('unsafe_integer'); return Number(value); }
function divisor(unit) { if(!Object.hasOwn(PROFILE.literal_divisors,unit)) fail('unit_mismatch'); return PROFILE.literal_divisors[unit]; }
function encodeDecimal(token,unit) {
  const div=divisor(unit);
  if(typeof token!=='string'||token.length>4096||! /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$(?![\s\S])/.test(token)) fail('invalid_decimal');
  const [mantissa, exponent='0']=token.split(/[eE]/);
  if(exponent.replace(/^[+-]/,'').replace(/^0+/,'').length>5) fail('invalid_decimal');
  const exp=Number(exponent); if(Math.abs(exp)>4096) fail('invalid_decimal');
  const sign=mantissa.startsWith('-')?-1n:1n;
  const fraction=(mantissa.split('.')[1]||'').length;
  let digits=mantissa.replace('-','').replace('.','').replace(/^0+/,'')||'0';
  const power=exp-fraction+(div===1000000?6:0);
  if(digits==='0') return 0;
  if(power<0) { const count=-power; if(count>=digits.length|| /[1-9]/.test(digits.slice(-count))) fail('inexact_decimal'); digits=digits.slice(0,-count); }
  else { if(digits.length+power>16) fail('unsafe_integer'); digits+='0'.repeat(power); }
  if(digits.length>16) fail('unsafe_integer');
  return result(sign*BigInt(digits));
}
function validateWire(codec,value,positive=false) {
  const fields=codec==='um'?['value_um']:codec==='vec3_um'?['x_um','y_um','z_um']:null;
  if(!fields||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k))) fail('wire_shape');
  for(const key of fields){safeInteger(value[key]);if(positive&&value[key]<=0) fail('positive_required');}
  return value;
}
function truncDiv(a,b){safeInteger(a);safeInteger(b);if(!b)fail('division_by_zero');return result(BigInt(a)/BigInt(b));}
function centerZ(base,height){safeInteger(base);safeInteger(height);if(height<=0)fail('positive_required');return result(BigInt(base)+BigInt(height)/2n);}
// Units are tags, not dimensions, and numericBinary never rescales by one.  It cannot: the 0.3
// compiler's typeSpec() keys the divisor off value_type alone, so every scalar it emits sits in the
// 1e6 lane whatever its unit says, and the 0.2 compiler rejects mismatched units statically before the
// interpreter is ever reached.  A mixed pair therefore always arrives already in one lane -- rescaling
// it by literal_divisors would multiply a duration by a million.  What the tag still decides is which
// unit the RESULT is labelled with, which is what the write-back reads.
function numericBinary(op,a,au,b,bu){
  safeInteger(a);safeInteger(b);divisor(au);divisor(bu);const x=BigInt(a),y=BigInt(b);let value,unit;
  if(['add','sub','min','max'].includes(op)){unit=au==='scalar'?bu:au;value=op==='add'?x+y:op==='sub'?x-y:op==='min'?(x<y?x:y):(x>y?x:y);}
  // m * m -> m is the product the old dimensional rule made impossible, which is why no scene could
  // express a squared distance.  One operand always carries the 1e6 factor, so the divide is constant.
  else if(op==='mul'){unit=au==='scalar'?bu:au;value=x*y/1000000n;}
  else if(op==='div'){if(!b)fail('division_by_zero');unit=bu==='scalar'?au:'scalar';value=x*1000000n/y;}
  else fail('unknown_operator');
  return {value:result(value),unit};
}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
return freeze({PROFILE,PROFILE_DIGEST,encodeDecimal,validateWire,truncDiv,centerZ,numericBinary,safeInteger});
});
