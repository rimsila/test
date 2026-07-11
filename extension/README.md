# Todo Developer Side Panel

A Chrome Manifest V3 side-panel extension plus a local Node.js server for:

- live project preview with automatic iframe refresh
- local Git status, pull, commit, push, and optional auto sync
- a Streamable HTTP MCP endpoint for ChatGPT and other MCP clients
- protected project file reading and editing through MCP tools

## Project layout

```text
extension/
├─ manifest.json
├─ background.js
├─ sidepanel.html
├─ sidepanel.css
├─ sidepanel.js
└─ server/
   ├─ src/server.js
   ├─ scripts/smoke-test.js
   ├─ package.json
   ├─ .env.example
   └─ settings.json
```

## 1. Configure and run the local server

```bash
cd extension/server
npm install
copy .env.example .env
npm start
```

On macOS or Linux, use `cp .env.example .env` instead of `copy`.

Edit `.env` first:

- `REPO_PATH`: local Git repository controlled by the Git tab and Git MCP tools.
- `PROJECT_PATH`: project exposed to preview and project-file MCP tools.
- `EXTENSION_TOKEN`: optional fallback token for the Chrome extension API. You can now set the active token from the side-panel UI instead.
- `MCP_TOKEN`: optional Bearer token for MCP clients that support a static token.
- `PREVIEW_COMMAND`: leave blank for the built-in static server, or set a development command such as `npm run dev -- --host 127.0.0.1`.
- `PREVIEW_URL`: URL the extension should open after starting preview.

Generate tokens with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `extension` folder.
5. Open the side panel, enter a token in the Git tab, and click **Save** to configure the local server from the UI.
6. If the server already has an `EXTENSION_TOKEN` in `.env`, enter that same token once and click **Save** so the UI can take over.

The extension remembers the selected tab, token, last preview URL, collapsed state, and tunnel URL in `chrome.storage.local`.

## 3. MCP endpoint and tools

The local MCP endpoint is:

```text
http://127.0.0.1:4783/mcp
```

It uses MCP Streamable HTTP and exposes 13 tools:

- `project_info`
- `list_files`
- `read_file`
- `write_file`
- `replace_in_file`
- `search_files`
- `delete_path`
- `git_status`
- `git_diff`
- `git_pull`
- `git_commit`
- `git_push`
- `preview_control`

File tools are restricted to `PROJECT_PATH`. Path traversal, symlink escapes, `.git`, `.env`, `node_modules`, SSH keys, and common credential files are blocked. Writes are atomic and support SHA-256 optimistic concurrency checks.

## 4. Connect ChatGPT Web

ChatGPT needs a public HTTPS MCP URL; it cannot directly reach `127.0.0.1` on your computer.

1. Run the server locally.
2. Create a private HTTPS tunnel to `http://127.0.0.1:4783` using a trusted tunnel provider.
3. Copy the tunnel URL ending in `/mcp`, for example `https://example-tunnel.test/mcp`.
4. In ChatGPT, enable Developer Mode, create a developer app, and enter that MCP URL.

### Authentication note

For clients that support a static Bearer token, keep `ALLOW_UNAUTHENTICATED_MCP=false` and configure `MCP_TOKEN`.

For temporary ChatGPT developer-mode testing without OAuth, you may set:

```env
ALLOW_UNAUTHENTICATED_MCP=true
```

Only do this while the tunnel is private and active for your test. Anyone who can reach an unauthenticated tunnel URL can invoke file and Git write tools. Turn it off after testing. A production/public deployment should use OAuth or an authenticated gateway.

## 5. Live preview behavior

When `PREVIEW_COMMAND` is blank, the server hosts `PROJECT_PATH` at `PREVIEW_URL` using a built-in static server. When a project file changes, the server emits an SSE event and the extension refreshes the preview iframe.

For framework projects, set `PREVIEW_COMMAND` and `PREVIEW_URL` to your framework's development server. Example:

```env
PREVIEW_COMMAND=npm run dev -- --host 127.0.0.1
PREVIEW_URL=http://127.0.0.1:5173
```

## 6. Verify the implementation

```bash
npm run check
npm run test:mcp
```

The smoke test checks extension API authentication, MCP authentication, initialize, tool discovery, a tool call, built-in preview startup, and MCP status.

## Git auto sync

Auto sync is off by default. When enabled, it only pulls and pushes if the working tree is clean. Pull uses `--ff-only`, so it never creates an automatic merge commit.
