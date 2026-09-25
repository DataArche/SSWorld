// Where the SSDL compiler and runtime live, and nothing else: modules that only need the compiler
// import this instead of paths.mjs, whose HOME is fixed the moment it is loaded -- a test that
// imports such a module statically would otherwise pin the real ~/.ssworld before it could point
// SSWORLD_HOME at a temporary directory.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED_SSDL_ROOT = path.join(PACKAGE_ROOT, "ssdl");
const SOURCE_SSDL_ROOT = path.resolve(PACKAGE_ROOT, "..");
// The published package carries a frozen closure under ssdl/. Source-tree tests use the repository closure.
export const SSDL_ROOT = existsSync(path.join(PACKAGED_SSDL_ROOT, "compiler", "src", "compiler-0.3.mjs"))
  ? PACKAGED_SSDL_ROOT
  : SOURCE_SSDL_ROOT;
