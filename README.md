# ssworld-mcp

SSWorld MCP server: lets any MCP-capable agent app (Claude Code, Codex, Hermes, Cursor …) author, compile and preview
3D geographic scenes written in **SSDL** (a QML-like scene description language) on the **SSEngine WebGPU** runtime.

## Install (one command)

```bash
npx -y github:DataArche/SSWorld install
```

This installs the package globally, registers the `ssworld` MCP server with every agent app it finds
(`--client=claude,codex,hermes,cursor` to choose), and downloads the pinned engine (≈54 MB) into `~/.ssworld/engine/`.

Requirements: Node.js ≥ 22, npm, a WebGPU browser (Chrome/Edge) to look at previews.

Manual registration for any other client:

```json
{ "mcpServers": { "ssworld": { "command": "node", "args": ["<npm root -g>/ssworld-mcp/bin/ssworld-mcp.mjs"] } } }
```

## Tools

| tool | purpose |
|------|---------|
| `ssworld_catalog` | component index / one component's full contract |
| `ssworld_project_list` | projects in `~/.ssworld/projects` |
| `ssworld_project_create` | new runnable project (anchored at lon/lat/height), compiled |
| `ssworld_source_read` / `ssworld_source_write` | digest-guarded edits of `.ssdl` sources |
| `ssworld_compile` | SSDL 0.3 compiler with real diagnostics |
| `ssworld_preview` | starts the local preview server, returns `http://127.0.0.1:8880/projects/<name>/index.html` |
| `ssworld_engine_status` | engine pair installed? (`install: true` to download) |

## CLI

```
ssworld-mcp                 # MCP stdio server (what agent apps launch)
ssworld-mcp install [--client=claude,codex] [--no-engine]
ssworld-mcp engine          # download / verify the pinned engine
ssworld-mcp preview [--port=8880]
ssworld-mcp doctor
```

Environment: `SSWORLD_HOME` (default `~/.ssworld`), `SSWORLD_PREVIEW_PORT` (8880), `SSWORLD_ENGINE_DIR` (use a local engine pair instead of the release download).

## Layout

`ssdl/compiler` is the byte-identical SSDL 0.3 compiler closure, `ssdl/runtime` the browser runtime, `ssdl/catalog` the
component catalog, `engine.lock.json` pins the SSmap.js/SSmap.wasm pair published as a GitHub Release asset.
Built by `src/ssdl/tools/pack_ssworld_mcp.py` in the SSEngine3 repository; do not edit here.
