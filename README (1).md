# Developer Side Panel

A small todo app plus a Chrome Manifest V3 extension for previewing local websites and managing a local Git repository from Chrome's right-side panel.

## Features

- Persistent Preview and Git tabs
- URL and current-tab preview
- Collapsible preview state
- Local Express server protected by a shared token
- Git status, pull, commit, and push controls
- Optional auto-sync, disabled by default
- MCP endpoint for ChatGPT Web tools
- Project file watching and live preview reload
- Configurable local preview process controls

## Project structure

- `index.html` — standalone todo app
- `extension/` — unpacked Chrome extension
- `extension/server/` — local Express and Git control server

See `extension/README.md` for installation and local server setup.
