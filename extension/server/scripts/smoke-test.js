import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-mcp-smoke-'));
const project = path.join(root, 'project');
await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, 'index.html'), '<h1>Todo App</h1>\n', 'utf8');

const port = 48783;
const previewPort = 48784;
const extensionToken = 'extension-smoke-token-123456789';
const mcpToken = 'mcp-smoke-token-123456789';

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port),
    PREVIEW_PORT: String(previewPort),
    REPO_PATH: project,
    PROJECT_PATH: project,
    EXTENSION_TOKEN: extensionToken,
    MCP_TOKEN: mcpToken,
    ALLOW_UNAUTHENTICATED_MCP: 'false',
    PREVIEW_COMMAND: '',
    PREVIEW_URL: `http://127.0.0.1:${previewPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Server did not start.\n${logs}`);
}

async function api(url, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Extension-Token': extensionToken,
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function mcp(body, token = mcpToken) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

try {
  await waitForServer();

  const health = await api('/api/health');
  assert.equal(health.ok, true);

  const unauthorized = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }, 'wrong-token');
  assert.equal(unauthorized.response.status, 401);

  const initialized = await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } });
  assert.equal(initialized.response.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, 'todo-local-dev');

  const tools = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.equal(tools.response.status, 200);
  assert.equal(tools.body.result.tools.length, 13);
  assert.ok(tools.body.result.tools.some((tool) => tool.name === 'write_file'));
  assert.ok(tools.body.result.tools.some((tool) => tool.name === 'preview_control'));

  const listed = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_files', arguments: { path: '.', depth: 2, limit: 20 } } });
  assert.equal(listed.response.status, 200);
  assert.match(listed.body.result.content[0].text, /index\.html/);

  const preview = await api('/api/preview/start', { method: 'POST' });
  assert.equal(preview.running, true);
  const previewResponse = await fetch(`http://127.0.0.1:${previewPort}/`);
  assert.equal(previewResponse.status, 200);
  assert.match(await previewResponse.text(), /Todo App/);

  const mcpStatus = await api('/api/mcp/status');
  assert.equal(mcpStatus.toolCount, 13);
  assert.equal(mcpStatus.ready, true);

  console.log('MCP smoke test passed: auth, initialize, tools/list, tools/call, preview, extension API.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3_000)]);
  await fs.rm(root, { recursive: true, force: true });
}
