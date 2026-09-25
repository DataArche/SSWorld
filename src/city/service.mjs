// HTTP surface of the city service, mounted on the preview server under /__ssworld/city/.
//
// Reads are open to anything that can reach the loopback port (the page is one of them). WRITES are
// not: a command changes a saved city, so it needs the session token this process minted, an Origin
// that is this same preview server, a loopback peer, and a project that actually carries a city.
// This is the whole security model and it is deliberately small -- it reuses the preview server
// rather than standing up an account system.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT } from "../paths.mjs";
import { cityStatus, queryCity, impactReport, commandCity, startRun, readRun, listRuns, runFrame, buildBuilding, hasCity } from "./host.mjs";

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SESSION_TOKEN = randomBytes(24).toString("hex");
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const ok = (value, status = 200) => ({ status, value: { ok: true, ...value } });
const fail = (error, status, extra = {}) => ({ status, value: { ok: false, error, ...extra } });

function projectDirectory(name) {
  if (!name || !NAME_RE.test(name)) return null;
  const directory = path.join(PROJECTS_ROOT, name);
  return existsSync(path.join(directory, "scene.ssdl")) ? directory : null;
}

/** A write is allowed only from this machine, this server's own page, with this process's token. */
function authoriseWrite({ origin, remote, port, body }) {
  if (remote && !LOOPBACK.has(remote)) return "remote_not_loopback";
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return "origin_not_allowed";
  if (body?.token !== SESSION_TOKEN) return "session_token_invalid";
  return null;
}

export function citySessionToken() { return SESSION_TOKEN; }

export async function cityEndpoint(route, { method, query, body, origin, remote, port }) {
  const name = method === "POST" ? body?.project : query.get("project");
  const directory = projectDirectory(name);
  if (!directory) return fail("project_not_found", 404, { project: name ?? null });

  try {
    if (method === "GET" && route === "status") {
      if (!hasCity(directory)) return ok({ project: name, imported: false });
      // The token only leaves the process for a caller that is already on the loopback interface.
      const token = remote && LOOPBACK.has(remote) ? SESSION_TOKEN : null;
      return ok({ project: name, token, ...cityStatus(directory) });
    }
    if (method === "GET" && route === "query") {
      const bbox = query.get("bbox");
      return ok({ project: name, ...queryCity(directory, {
        id: query.get("id"), kind: query.get("kind"), revision: query.get("revision"),
        bbox: bbox ? bbox.split(",").map(Number) : null,
        limit: query.get("limit") ? Number(query.get("limit")) : 200,
      }) });
    }
    if (method === "GET" && route === "impact") {
      return ok({ project: name, ...impactReport(directory, { revision: query.get("revision") }) });
    }
    if (method === "GET" && route === "runs") {
      const id = query.get("run");
      return ok({ project: name, ...(id ? { run: readRun(directory, id) } : { runs: listRuns(directory) }) });
    }
    if (method === "GET" && route === "run_frame") {
      return ok({ project: name, ...runFrame(directory, { run_id: query.get("run"), cursor: Number(query.get("cursor") ?? 0) }) });
    }

    if (method === "POST") {
      const denied = authoriseWrite({ origin, remote, port, body });
      if (denied) return fail(denied, 403);
      if (route === "command") {
        return ok({ project: name, ...commandCity(directory, {
          command_id: body.command_id ?? null, kind: body.kind, params: body.params ?? {},
          expected_revision: body.expected_revision ?? null, source: body.source ?? "preview_page",
        }) });
      }
      if (route === "run") {
        return ok({ project: name, ...startRun(directory, body.run ?? {}) });
      }
      if (route === "build") {
        return ok({ project: name, ...buildBuilding(directory, body.build ?? {}) });
      }
    }
    return fail("unknown_city_route", 404, { route });
  } catch (error) {
    const status = error.code === "revision_stale" ? 409 : error.code === "object_not_found" || error.code === "run_not_found" ? 404 : 400;
    return fail(String(error.message), status, { code: error.code ?? null, ...(error.extra ?? {}) });
  }
}
