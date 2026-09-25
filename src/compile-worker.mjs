// Runs the SSDL compiler off the server's event loop. A large project takes seconds to compile, and
// in-process that froze the preview server -- page syncs, captures and every other request waited on
// it. The worker also takes the compile's peak memory with it when it exits.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const { compilerPath, project, options } = workerData;
try {
  const { compileSceneModuleProject } = await import(pathToFileURL(compilerPath).href);
  const result = compileSceneModuleProject(project, options);
  // Only what the server reads crosses back; the rest of the compilation stays here and is freed.
  parentPort.postMessage({
    ok: true,
    result: {
      emitted: { module: result.emitted.module, source_map: result.emitted.source_map, manifest: result.emitted.manifest },
      scene_ir: result.scene_ir,
      binding_ir: result.binding_ir,
    },
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: { message: error?.message || String(error), code: error?.code, diagnostic: error?.diagnostic },
  });
}
