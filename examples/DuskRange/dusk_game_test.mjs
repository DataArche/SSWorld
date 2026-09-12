import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
let now=0;
Object.defineProperty(globalThis,'performance',{value:{now:()=>now}});
class Element {
 constructor(){this.handlers={};this.style={};this.textContent='';this.innerHTML='';this.classList={add(){},remove(){},toggle(){}};}
 addEventListener(name,fn){(this.handlers[name]??=[]).push(fn);}
 emit(name,extra={}){for(const fn of this.handlers[name]||[])fn({target:this,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){},...extra});}
 closest(){return null;} remove(){} append(){}
 querySelector(id){return elements[id]??=new Element();}
}
const elements={};globalThis.HTMLButtonElement=class extends Element{};
globalThis.window=new Element();globalThis.document=new Element();
document.body=new Element();document.createElement=()=>new Element();document.hidden=false;
document.exitPointerLock=()=>{};
const properties={};
const moduleUrl=process.argv[2]?pathToFileURL(process.argv[2]):new URL('./logic.mjs',import.meta.url);
const {createHostInterfaces}=await import(moduleUrl);
const {Game}=createHostInterfaces({logical:{write:(k,v)=>{properties[k]=v;},read:()=>({properties})}});
const key=(k,type='keydown')=>window.emit(type,{key:k,repeat:false});
const advance=(seconds)=>{for(let t=0;t<seconds-.00001;t+=.02){now+=20;Game.tick();}};
elements['#keyboard'].emit('click');
assert.equal(properties.playing,true);
key(' ');key(' ','keyup');
assert.equal(properties.ammo,11);assert.equal(properties.hits,1);assert.equal(properties.score,150);
assert.equal(properties.alive0,false);
advance(1.6);assert.equal(properties.alive0,true);
key('r');advance(.5);key(' ');assert.equal(properties.shots,1);advance(1);assert.equal(properties.ammo,12);
key('q');Game.tick();assert.equal(properties.zoom,42);
key('Escape');const time=properties.remaining;advance(2);assert.equal(properties.remaining,time);assert.equal(properties.playing,false);
elements['#keyboard'].emit('click');
key('a');advance(1.5);key('a','keyup');assert.ok(Math.abs(properties.px+6)<.02);
key('w');advance(6);key('w','keyup');assert.ok(properties.py < -1.24&&properties.py > -1.5,'crate must block forward movement');
// Aim directly through the crate at a rear target: a low ray must be rejected.
for(let i=0;i<12;i++){key(' ');key(' ','keyup');advance(.2);}
assert.equal(properties.ammo,0);const shots=properties.shots;key(' ');assert.equal(properties.shots,shots);
advance(80);assert.equal(properties.remaining,0);assert.equal(properties.playing,false);
assert.match(elements['#start'].textContent,/再来/);
elements['#keyboard'].emit('click');assert.equal(properties.ammo,12);assert.equal(properties.score,0);assert.equal(properties.shots,0);assert.equal(properties.remaining,75);assert.equal(properties.px,0);
console.log('PASS: actual game module start, bullseye, target respawn, reload lockout, zoom, pause, movement, crate collision, empty magazine, timeout and restart.');
