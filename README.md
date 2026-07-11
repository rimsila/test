# Todo Developer Side Panel

A small Todo App plus a Chrome Manifest V3 extension and local Node.js MCP server for previewing code, controlling Git, and connecting local project tools to ChatGPT Developer Mode.

## Features

- Persistent Preview, Git, and MCP tabs
- Local website preview with file-watch refresh
- Git status, pull, commit, push, and optional auto sync
- Streamable HTTP MCP endpoint at `/mcp`
- 13 project, Git, and preview MCP tools
- Token-protected extension API and optional MCP Bearer authentication
- Project-path confinement, sensitive-file blocking, atomic writes, and SHA-256 conflict checks
- Built-in static preview or configurable framework development command
- MCP smoke-test script

## Project structure

```text
index.html                    # Standalone Todo App
extension/                    # Chrome side-panel extension
extension/server/             # Express, Git, preview, and MCP server
extension/server/src/server.js
extension/server/scripts/smoke-test.js
```

See [`extension/README.md`](extension/README.md) for installation, configuration, security notes, and ChatGPT connection steps.
