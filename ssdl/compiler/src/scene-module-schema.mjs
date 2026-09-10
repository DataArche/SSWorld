export const SCENE_MODULE_VERSION = 1;

export function assertSceneModuleManifest(manifest) {
  const digest = /^sha256:[0-9a-f]{64}$/;
  if (!manifest || manifest.schema_version !== "SceneModuleManifest/1"
      || manifest.scene_module_version !== SCENE_MODULE_VERSION
      || typeof manifest.entry !== "string" || !manifest.entry
      || !digest.test(manifest.catalog_digest || "")
      || !digest.test(manifest.runtime_abi_digest || "")
      || !digest.test(manifest.compiler_profile_digest || "")
      || !digest.test(manifest.scene_ir_digest || "")
      || !digest.test(manifest.binding_ir_digest || "")
      || !digest.test(manifest.module_digest || "")) {
    throw Object.assign(new Error("invalid SceneModule/1 manifest"), {
      code: "scene_module_manifest_invalid",
    });
  }
  return manifest;
}
