import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const config=JSON.parse(await fs.readFile(path.resolve(root,process.argv[2]||'tools/road_template/configs/guanlan.json'),'utf8'));
const plugin=process.env.SSWORLD_PACKAGE||path.join(os.homedir(),'.codex/plugins/cache/ssworld/ssworld/local');
const {compileProject}=await import(pathToFileURL(path.join(plugin,'src/compile.mjs')));
const {renderTemplate,pageValues}=await import(pathToFileURL(path.join(plugin,'src/page.mjs')));
const out=path.resolve(root,config.output_dir);
// New site: no generation yet, so the scene is a placeholder that only hosts the coordinate-conversion button.
if(!await fs.access(path.join(out,'scene.ssdl')).then(()=>true,()=>false)){
  await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(out,'scene.ssdl'),'Scene {\n id: main\n property real viewMode: 0\n SkyAtmosphere { id: sky }\n DirectionalLight { id: sun; atmosphereSunLight: true; intensity: 1.35 }\n}\n');
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify({schema:'RoadTemplateReport/1',bootstrap:true,counts:{roads:'—',blocks:'—'}}));
  console.error('Bootstrap page written: run --serve-projection, open the preview, press the conversion button, then generate.');
}
const anchor={lon:config.anchor[0],lat:config.anchor[1],height:config.anchor[2]};
const site={title:config.name,label:config.name.toUpperCase(),page_title:config.name,...config.site};
const values=pageValues(config.name,{title:site.page_title,anchor});
const clock=(config.lighting?.date_time||'2026-11-05T16:15:00+08:00').slice(11,16);
const template=await fs.readFile(path.join(plugin,'template/index.html'),'utf8');
const page=renderTemplate(template,values);
const head=page.slice(page.indexOf('<head>')+6,page.indexOf('</head>'));
// Retain the vendor's engine boot/sync/capture module; own only the product overlay.
const scripts=[...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
const runtime=scripts.find(m=>m[1].includes('SceneModuleHost'))[0].replace('snapshot: () => host.snapshotGeneration("ssworld-project"),','snapshot: () => host.snapshotGeneration("ssworld-project"),\n            recallView: () => bridge.graph.get("view").writeCamera(),');
const shell=await fs.readFile(path.join(root,'tools/road_template/viewer.html'),'utf8');
const filled=shell.replaceAll('{{SITE}}',site.title).replaceAll('{{SITE_LABEL}}',site.label).replaceAll('{{CLOCK}}',clock)
  .replaceAll('{{HOUR}}',String(+clock.slice(0,2)+(+clock.slice(3))/60));
await fs.writeFile(path.join(out,'index.html'),filled.replace('<!--HEAD-->',head).replace('<!--RUNTIME-->',runtime));
await fs.copyFile(path.join(root,'tools/road_template/viewer.css'),path.join(out,'style.css'));
await fs.copyFile(path.join(root,'tools/road_template/viewer.mjs'),path.join(out,'viewer.mjs'));
await fs.copyFile(path.join(root,'tools/road_template/engine_project.mjs'),path.join(out,'engine-project.mjs'));
const sceneHost=renderTemplate(await fs.readFile(path.join(plugin,'template/scene.mjs'),'utf8'),values);
await fs.writeFile(path.join(out,'scene.mjs'),sceneHost);
const manifest={schema_version:'SceneModuleManifest/1',scene_module_version:1,name:config.name,entry:'scene.mjs',execution_profiles:['trusted-local','agent-mcp'],resource_root:'.',anchor};
await fs.writeFile(path.join(out,'showcase.manifest.json'),JSON.stringify(manifest,null,2));
const result=await compileProject(out,{name:config.name});
await fs.writeFile(path.join(out,'compile-receipt.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:true,output:out,node_count:result.node_count,native_objects:result.usage.native_objects.used,instances:result.usage.instances.used,assets:result.usage.assets.count},null,2));
