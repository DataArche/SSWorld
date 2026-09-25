// Create the empty SSWorld preview project named by a config (once per site), anchored at config.anchor.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const config=JSON.parse(await fs.readFile(path.resolve(root,process.argv[2]||'tools/road_template/configs/guanlan.json'),'utf8'));
const plugin=process.env.SSWORLD_PACKAGE||path.join(os.homedir(),'.codex/plugins/cache/ssworld/ssworld/local');
const {createProject}=await import(pathToFileURL(path.join(plugin,'src/project.mjs')));
const [lon,lat,height]=config.anchor;
const result=await createProject(config.name,{anchor:{lon,lat,height},template:'empty',title:config.site?.page_title||config.name});
console.log(JSON.stringify({project:result.project,directory:result.directory,url:`http://127.0.0.1:8880/projects/${config.name}/index.html`},null,2));
