// Reapply after ssworld_compile: two host entry points the SSWorld template does not ship.
// The region between the markers is owned by this file, so re-running it upgrades an older copy
// instead of refusing to touch it.
import fs from 'node:fs';
const url=new URL('./scene.mjs',import.meta.url);
const OPEN='    // >>> skylinegarden host extensions',CLOSE='    // <<< skylinegarden host extensions';
const BLOCK=`${OPEN}
    // Explicit point-light positions avoid depending on parent-transform propagation in the bundled
    // native environment facade. Ids with no component yet (a fragment still on the native spawn
    // queue) come back to the caller, which retries exactly those instead of rewriting every round.
    carLightPositions: (updates) => {
      const writes=[],missing=[];
      for(const {id,position} of updates){
        const target=ctx.runtime.runtime.environmentComponents.get(id);
        if(target&&!target.disposed)writes.push({target,property:'position',value:{x:position[0],y:position[1],z:position[2]}});
        else missing.push(id);
      }
      if(writes.length){
        const result=ctx.runtime.commitEventBatch(writes);
        if(!result.ok)throw new Error('Vehicle light position batch was refused: '+JSON.stringify(result.failure));
      }
      return missing;
    },
    // The live camera in WGS84 degrees. car-point-lights.mjs turns it into the anchor's local metres
    // to decide which cars are close enough for their 15 m point light to reach anything on screen.
    cameraGeodetic: () => {
      const camera=ctx.viewer?.scene?.mainCamera;
      if(!camera)return null;
      const carto=camera.cameraController().positionCartographic;
      if(!carto)return null;
      const degrees=typeof carto.toDegrees==='function'?carto.toDegrees():null;
      const out=degrees?{longitude:degrees.longitude??degrees.lon,latitude:degrees.latitude??degrees.lat,height:degrees.height??carto.height}:null;
      // Both are owned wrappers handed back by a factory call; the controller itself is not.
      for(const handle of [degrees,carto])if(handle&&typeof handle.delete==='function')handle.delete();
      return out;
    },
${CLOSE}`;
const marker='    ...worldApi(ctx),';
let source=fs.readFileSync(url,'utf8');
const start=source.indexOf(OPEN),end=source.indexOf(CLOSE);
if(start!==-1&&end!==-1){
  source=source.slice(0,start)+BLOCK+source.slice(end+CLOSE.length);
}else{
  // Pre-marker copy: drop the first generation's hand-inserted carLightPositions, then insert.
  const legacy=source.match(/ {4}carLightPositions: \(updates\) => \{[\s\S]*?\n {4}\},\n/);
  if(legacy)source=source.replace(legacy[0],'');
  if(!source.includes(marker))throw new Error('SSWorld host extension point changed');
  source=source.replace(marker,marker+'\n'+BLOCK);
}
fs.writeFileSync(url,source);
console.log('patched scene.mjs host extensions');
