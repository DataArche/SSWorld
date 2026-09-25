#!/usr/bin/env node
import { PACKAGE, PREVIEW_PORT } from "../src/paths.mjs";

const [command = "serve", ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter((arg) => arg.startsWith("--")).map((arg) => {
  const [key, value] = arg.slice(2).split("=");
  return [key, value === undefined ? true : value];
}));

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`ssworld-mcp needs Node.js >= 22 (found ${process.versions.node})\n`);
  process.exit(1);
}

switch (command) {
  case "serve":
  case "stdio": {
    const { serveStdio } = await import("../src/server.mjs");
    await serveStdio();
    break;
  }
  case "preview": {
    const { serveForever } = await import("../src/preview.mjs");
    await serveForever(Number(flags.port || PREVIEW_PORT));
    break;
  }
  case "city": {
    // The city demo: import the shipped real-site dataset, serve it, and play the delivery chain
    // (route -> close a door -> rebuild a building -> raise the river -> evacuate) while a browser
    // watches. The preview server this starts is the one serveForever reuses below, so the page
    // stays up after the chain has played.
    const { cityDemo } = await import("../src/city/demo.mjs");
    const toMs = (value, fallback) => (value === undefined ? fallback : Math.max(0, Number(value) * 1000));
    const summary = await cityDemo({
      project: flags.project ? String(flags.project) : undefined,
      dataset: flags.dataset ? String(flags.dataset) : null,
      port: flags.port ? Number(flags.port) : null,
      reset: Boolean(flags.reset), replay: Boolean(flags.replay),
      play: !flags["no-play"], serve: !flags["no-serve"],
      pause: toMs(flags.pause, 6000), waitForPageMs: toMs(flags.wait, 120000),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    if (flags.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    if (flags["no-serve"] || flags.exit) break;
    const { serveForever } = await import("../src/preview.mjs");
    await serveForever(Number(flags.port || PREVIEW_PORT));
    break;
  }
  case "engine": {
    const { ensureEngine } = await import("../src/engine.mjs");
    const status = await ensureEngine({ log: (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    break;
  }
  case "install": {
    const { install } = await import("../src/install.mjs");
    const clients = flags.client ? String(flags.client).split(",") : [];
    const result = await install({ clients, engine: !flags["no-engine"], spec: flags.spec, print: Boolean(flags.print), local: Boolean(flags.local) });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    break;
  }
  case "doctor": {
    const { engineStatus } = await import("../src/engine.mjs");
    const { previewStatus } = await import("../src/preview.mjs");
    process.stdout.write(JSON.stringify({ version: PACKAGE.version, node: process.versions.node, engine: engineStatus(), preview: await previewStatus() }, null, 2) + "\n");
    break;
  }
  case "--version":
  case "version":
    process.stdout.write(`${PACKAGE.name} ${PACKAGE.version}\n`);
    break;
  default:
    process.stderr.write(`usage: ssworld-mcp [serve|install [--client=claude,codex,hermes,cursor,dsh] [--no-engine] [--local]|engine|preview [--port=N]|city [--project=riverside] [--dataset=DIR] [--port=N] [--reset] [--pause=S] [--wait=S] [--no-play] [--exit] [--json]|doctor|version]\n`);
    process.exit(command === "--help" || command === "help" ? 0 : 2);
}
