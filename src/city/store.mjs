// City version store: one immutable baseline, a chain of scenario revisions, an append-only command
// log and the runs those commands produced. Single writer, plain files.
//
// Three rules the rest of the module depends on:
//   1. baseline.json is written ONCE. Every later change is an override on top of it, so the imported
//      survey can always be recovered and compared against.
//   2. Every command is appended to commands.jsonl BEFORE its revision file is written. A crash in
//      between is recoverable (recover() replays the log); the reverse order loses the record of a
//      change that already happened.
//   3. command_id is the idempotency key. Re-sending a command returns the ORIGINAL result, it does
//      not apply it twice -- a retried "move the gate" must not move it 20 m.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CITY_STORE_SCHEMA = "SSWorldCityStore/1";
export const CITY_DIR = "city";

const digestOf = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
const revisionName = (index) => `rev-${String(index).padStart(4, "0")}`;
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export const EMPTY_OVERRIDES = Object.freeze({
  portals: {}, buildings: {}, parcels: {}, water: {}, hazards: {}, closures: { edges: {} },
  demand: { added: [], removed: [] }, population: {}, assets: {}, recipes: {}, notes: [],
});

function cloneOverrides(overrides) {
  return JSON.parse(JSON.stringify(overrides ?? EMPTY_OVERRIDES));
}

export class CityStore {
  constructor(projectDirectory) {
    this.root = path.join(projectDirectory, CITY_DIR);
    this.revisionsDir = path.join(this.root, "revisions");
    this.runsDir = path.join(this.root, "runs");
    this.logFile = path.join(this.root, "commands.jsonl");
    this.baselineFile = path.join(this.root, "baseline.json");
    this.headFile = path.join(this.root, "head.json");
  }

  get exists() { return existsSync(this.baselineFile); }

  /** Write the imported model as the immutable baseline plus revision 0 (no overrides). */
  initialise(model, { datasetDirectory, importedBy = "ssworld_city_import" }) {
    if (this.exists) {
      throw Object.assign(new Error(`this project already carries a city baseline (${this.head().revision}); import into a new project or command the existing one`),
        { code: "city_baseline_exists" });
    }
    mkdirSync(this.revisionsDir, { recursive: true });
    mkdirSync(this.runsDir, { recursive: true });
    const baseline = {
      schema_version: CITY_STORE_SCHEMA,
      imported_at: new Date().toISOString(),
      imported_by: importedBy,
      dataset_directory: datasetDirectory,
      model_digest: digestOf(model),
      model,
    };
    writeJson(this.baselineFile, baseline);
    const revision = { schema_version: CITY_STORE_SCHEMA, revision: revisionName(0), index: 0, parent: null,
      command_id: null, created_at: baseline.imported_at, overrides: cloneOverrides(EMPTY_OVERRIDES),
      baseline_digest: baseline.model_digest };
    writeJson(path.join(this.revisionsDir, `${revision.revision}.json`), revision);
    writeJson(this.headFile, { revision: revision.revision, index: 0, seq: 0 });
    if (!existsSync(this.logFile)) writeFileSync(this.logFile, "", "utf8");
    return { baseline, revision };
  }

  baseline() {
    if (!this.exists) throw Object.assign(new Error("this project has no city baseline; run ssworld_city_import first"), { code: "city_not_imported" });
    return readJson(this.baselineFile);
  }

  head() { return readJson(this.headFile); }

  revision(name) {
    const target = path.join(this.revisionsDir, `${name}.json`);
    if (!existsSync(target)) throw Object.assign(new Error(`unknown revision '${name}'`), { code: "revision_not_found" });
    return readJson(target);
  }

  revisions() {
    return readdirSync(this.revisionsDir).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort();
  }

  log() {
    if (!existsSync(this.logFile)) return [];
    return readFileSync(this.logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  findCommand(commandId) {
    return this.log().find((entry) => entry.command_id === commandId) ?? null;
  }

  /**
   * Apply one command: append the record, then write the revision it produced.
   * @param apply (overrides, context) -> { overrides, effect } -- pure, so a replay of the log
   *              reconstructs exactly the same revision.
   */
  applyCommand({ command_id, kind, params, expected_revision = null, effective_at_s = null, source = null }, apply) {
    const existing = command_id ? this.findCommand(command_id) : null;
    if (existing) return { ...existing, replayed: true };
    const head = this.head();
    if (expected_revision && expected_revision !== head.revision) {
      throw Object.assign(new Error(`command expected revision '${expected_revision}' but the city is at '${head.revision}'`),
        { code: "revision_stale", extra: { head_revision: head.revision } });
    }
    const current = this.revision(head.revision);
    const next = apply(cloneOverrides(current.overrides), { baseline: this.baseline().model, revision: current });
    const index = head.index + 1;
    const name = revisionName(index);
    const record = {
      seq: head.seq + 1,
      command_id: command_id || randomUUID(),
      kind, params,
      source_revision: head.revision,
      applied_revision: name,
      effective_at_s,
      received_at: new Date().toISOString(),
      source,
      effect: next.effect ?? null,
      overrides_digest: digestOf(next.overrides),
    };
    appendFileSync(this.logFile, `${JSON.stringify(record)}\n`, "utf8");
    writeJson(path.join(this.revisionsDir, `${name}.json`), {
      schema_version: CITY_STORE_SCHEMA, revision: name, index, parent: head.revision,
      command_id: record.command_id, created_at: record.received_at, overrides: next.overrides,
      baseline_digest: this.baseline().model_digest,
    });
    writeJson(this.headFile, { revision: name, index, seq: record.seq });
    return { ...record, replayed: false };
  }

  /** Rebuild any revision file the log says exists but the disk lost (crash between the two writes). */
  recover(rebuild) {
    const restored = [];
    let overrides = cloneOverrides(EMPTY_OVERRIDES);
    let head = { revision: revisionName(0), index: 0, seq: 0 };
    for (const record of this.log()) {
      const next = rebuild(cloneOverrides(overrides), record);
      overrides = next.overrides;
      const file = path.join(this.revisionsDir, `${record.applied_revision}.json`);
      if (!existsSync(file)) {
        writeJson(file, { schema_version: CITY_STORE_SCHEMA, revision: record.applied_revision,
          index: Number(record.applied_revision.slice(4)), parent: record.source_revision,
          command_id: record.command_id, created_at: record.received_at, overrides,
          baseline_digest: this.baseline().model_digest });
        restored.push(record.applied_revision);
      }
      head = { revision: record.applied_revision, index: Number(record.applied_revision.slice(4)), seq: record.seq };
    }
    writeJson(this.headFile, head);
    return { restored, head };
  }

  writeRun(run) {
    mkdirSync(this.runsDir, { recursive: true });
    writeJson(path.join(this.runsDir, `${run.run_id}.json`), run);
    return run;
  }

  readRun(runId) {
    const target = path.join(this.runsDir, `${runId}.json`);
    if (!existsSync(target)) throw Object.assign(new Error(`unknown run '${runId}'`), { code: "run_not_found" });
    return readJson(target);
  }

  runs() {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir).filter((file) => file.endsWith(".json"))
      .map((file) => readJson(path.join(this.runsDir, file)))
      .map((run) => ({ run_id: run.run_id, kind: run.kind, revision: run.revision, created_at: run.created_at,
        sim_time_s: run.result?.sim_time_s ?? null, completed: run.result?.completed ?? null }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}

export { digestOf as cityDigest };
