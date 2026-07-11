import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import chokidar from 'chokidar';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

dotenv.config();

const execFileAsync = promisify(execFile);
const app = express();
const PORT = toPositiveInt(process.env.PORT, 4783);
const PREVIEW_PORT = toPositiveInt(process.env.PREVIEW_PORT, 5173);
const REPO_PATH = path.resolve(process.env.REPO_PATH || '.');
const PROJECT_PATH = path.resolve(process.env.PROJECT_PATH || REPO_PATH);
const ENV_EXTENSION_TOKEN = String(process.env.EXTENSION_TOKEN || '').trim();
const MCP_TOKEN = String(process.env.MCP_TOKEN || '');
const ALLOW_UNAUTHENTICATED_MCP = String(process.env.ALLOW_UNAUTHENTICATED_MCP || 'false').toLowerCase() === 'true';
const PREVIEW_COMMAND = String(process.env.PREVIEW_COMMAND || '').trim();
const PREVIEW_URL = String(process.env.PREVIEW_URL || `http://127.0.0.1:${PREVIEW_PORT}`);
const SETTINGS_FILE = path.resolve(process.env.SETTINGS_FILE || path.join(process.cwd(), 'settings.json'));
const AUTO_SYNC_INTERVAL_MS = Math.max(1, Number(process.env.AUTO_SYNC_INTERVAL_MINUTES || 5)) * 60_000;
const MAX_FILE_BYTES = Math.max(16_384, Number(process.env.MAX_FILE_BYTES || 1_048_576));
const MAX_READ_BYTES = Math.max(4_096, Number(process.env.MAX_READ_BYTES || 262_144));
const MAX_TOOL_OUTPUT_CHARS = Math.max(8_192, Number(process.env.MAX_TOOL_OUTPUT_CHARS || 200_000));
const MCP_TOOL_COUNT = 13;

let settings = { autoSync: false, extensionToken: '' };
let syncRunning = false;
let gitQueue = Promise.resolve();
let previewProcess = null;
let previewServer = null;
let previewStartedAt = null;
let shuttingDown = false;
const eventClients = new Set();

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function timingSafeTokenEqual(expected, supplied) {
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function normalizeSettings(value = {}) {
  return {
    autoSync: value.autoSync === true,
    extensionToken: typeof value.extensionToken === 'string' ? value.extensionToken.trim() : '',
  };
}

function activeExtensionToken() {
  return settings.extensionToken || ENV_EXTENSION_TOKEN;
}

function extensionTokenSource() {
  if (settings.extensionToken) return 'ui';
  if (ENV_EXTENSION_TOKEN) return 'env';
  return 'none';
}

function publicSettings() {
  return { autoSync: settings.autoSync };
}

function extensionConfigStatus() {
  const source = extensionTokenSource();
  return {
    configured: source !== 'none',
    source,
  };
}

function clip(value, max = MAX_TOOL_OUTPUT_CHARS) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n… output truncated (${text.length - max} more characters)`;
}

function jsonResult(value, isError = false) {
  return {
    isError,
    content: [{ type: 'text', text: clip(JSON.stringify(value, null, 2)) }],
  };
}

function errorResult(error) {
  return jsonResult({ error: error?.message || String(error) }, true);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function formatGitError(error) {
  const details = `${error?.stderr || ''}\n${error?.stdout || ''}\n${error?.message || ''}`.trim();
  if (details.includes('not a git repository')) {
    return createHttpError(400, `REPO_PATH is not a Git repository: ${REPO_PATH}`);
  }
  if (details.includes('ENOENT') || details.includes('no such file or directory')) {
    return createHttpError(400, `REPO_PATH does not exist or is not accessible: ${REPO_PATH}`);
  }
  error.message = clip(error?.stderr?.trim() || error?.stdout?.trim() || error?.message || 'Git operation failed.');
  return error;
}

function runSerializedGit(task) {
  const next = gitQueue.then(task, task);
  gitQueue = next.catch(() => undefined);
  return next;
}

async function git(args, { timeout = 120_000 } = {}) {
  return runSerializedGit(async () => {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: REPO_PATH,
        windowsHide: true,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return clip(`${stdout}${stderr}`.trim());
    } catch (error) {
      throw formatGitError(error);
    }
  });
}

async function gitStatus() {
  const output = await git(['status', '--porcelain=v2', '--branch']);
  const branch = output.match(/^# branch\.head (.+)$/m)?.[1] || '';
  const upstream = output.match(/^# branch\.upstream (.+)$/m)?.[1] || '';
  const aheadBehind = output.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
  const changes = output.split('\n').filter((line) => /^[12?u] /.test(line));
  return {
    branch,
    upstream,
    ahead: Number(aheadBehind?.[1] || 0),
    behind: Number(aheadBehind?.[2] || 0),
    changedFiles: changes.length,
    clean: changes.length === 0,
    summary: changes.join('\n'),
  };
}

async function loadSettings() {
  try {
    settings = normalizeSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')));
  } catch {
    settings = normalizeSettings();
    await saveSettings();
  }
}

async function saveSettings() {
  settings = normalizeSettings(settings);
  await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isSensitiveRelativePath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments.some((segment) => segment === '.git' || segment === 'node_modules' || segment === '.ssh')
    || segments.some((segment) => segment === '.env' || (segment.startsWith('.env.') && segment !== '.env.example'))
    || segments.some((segment) => /^(id_rsa|id_ed25519|credentials|secrets?\.json)$/i.test(segment));
}

async function resolveProjectPath(relativePath, { allowRoot = false, allowMissing = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw createHttpError(400, 'Path must be a valid project-relative string.');
  }
  const normalized = relativePath.trim().replaceAll('\\', '/').replace(/^\.\//, '') || '.';
  if (path.isAbsolute(normalized)) throw createHttpError(400, 'Absolute paths are not allowed.');
  if (isSensitiveRelativePath(normalized)) throw createHttpError(403, 'Access to sensitive project paths is blocked.');

  const rootReal = await fs.realpath(PROJECT_PATH).catch(() => PROJECT_PATH);
  const target = path.resolve(PROJECT_PATH, normalized);
  if (!isInside(PROJECT_PATH, target)) throw createHttpError(403, 'Path escapes PROJECT_PATH.');
  if (!allowRoot && target === PROJECT_PATH) throw createHttpError(400, 'The project root is not allowed for this operation.');

  let existing = target;
  while (existing !== PROJECT_PATH) {
    try {
      await fs.lstat(existing);
      break;
    } catch {
      existing = path.dirname(existing);
    }
  }
  const existingReal = await fs.realpath(existing).catch(() => existing);
  if (!isInside(rootReal, existingReal)) throw createHttpError(403, 'Path resolves outside PROJECT_PATH through a symlink.');

  try {
    const targetReal = await fs.realpath(target);
    if (!isInside(rootReal, targetReal)) throw createHttpError(403, 'Path resolves outside PROJECT_PATH through a symlink.');
  } catch (error) {
    if (!allowMissing && error?.code === 'ENOENT') throw createHttpError(404, `Path not found: ${normalized}`);
    if (error?.statusCode) throw error;
  }

  return { absolute: target, relative: normalized === '.' ? '.' : path.relative(PROJECT_PATH, target).replaceAll('\\', '/') };
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

async function readTextFile(relativePath) {
  const safe = await resolveProjectPath(relativePath);
  const stat = await fs.stat(safe.absolute);
  if (!stat.isFile()) throw createHttpError(400, 'Path is not a file.');
  if (stat.size > MAX_READ_BYTES) throw createHttpError(413, `File exceeds MAX_READ_BYTES (${MAX_READ_BYTES}).`);
  const buffer = await fs.readFile(safe.absolute);
  if (looksBinary(buffer)) throw createHttpError(415, 'Binary files are not supported.');
  return { ...safe, content: buffer.toString('utf8'), size: stat.size, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

async function writeTextFile(relativePath, content, { overwrite = true, expectedSha256 } = {}) {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) throw createHttpError(413, `Content exceeds MAX_FILE_BYTES (${MAX_FILE_BYTES}).`);
  const safe = await resolveProjectPath(relativePath, { allowMissing: true });
  await fs.mkdir(path.dirname(safe.absolute), { recursive: true });

  let exists = true;
  let currentSha256 = null;
  try {
    const current = await fs.readFile(safe.absolute);
    currentSha256 = crypto.createHash('sha256').update(current).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') exists = false;
    else throw error;
  }
  if (exists && !overwrite) throw createHttpError(409, 'File already exists and overwrite is false.');
  if (expectedSha256 && currentSha256 !== expectedSha256) {
    throw createHttpError(409, `File changed since it was read. Expected ${expectedSha256}, found ${currentSha256 || 'missing'}.`);
  }

  const temp = `${safe.absolute}.mcp-${randomUUID()}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, safe.absolute);
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  broadcast('file-change', { event: 'write', path: safe.relative, at: new Date().toISOString() });
  return { path: safe.relative, bytes, sha256, created: !exists };
}

async function listProjectFiles(relativePath = '.', depth = 4, limit = 300) {
  const safe = await resolveProjectPath(relativePath, { allowRoot: true });
  const rootStat = await fs.stat(safe.absolute);
  if (!rootStat.isDirectory()) throw createHttpError(400, 'Path is not a directory.');
  const results = [];

  async function walk(directory, currentDepth) {
    if (results.length >= limit || currentDepth > depth) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) break;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(PROJECT_PATH, absolute).replaceAll('\\', '/');
      if (isSensitiveRelativePath(relative)) continue;
      if (entry.isSymbolicLink()) {
        results.push({ path: relative, type: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        results.push({ path: `${relative}/`, type: 'directory' });
        if (currentDepth < depth) await walk(absolute, currentDepth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        results.push({ path: relative, type: 'file', size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
    }
  }

  await walk(safe.absolute, 0);
  return { base: safe.relative, files: results, truncated: results.length >= limit };
}

async function searchProject(query, globSuffix = '', maxResults = 50) {
  const needle = query.toLowerCase();
  const matches = [];
  const all = await listProjectFiles('.', 20, 5_000);
  for (const item of all.files) {
    if (matches.length >= maxResults) break;
    if (item.type !== 'file' || item.size > MAX_READ_BYTES) continue;
    if (globSuffix && !item.path.toLowerCase().endsWith(globSuffix.toLowerCase())) continue;
    let file;
    try { file = await readTextFile(item.path); } catch { continue; }
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      if (lines[index].toLowerCase().includes(needle)) {
        matches.push({ path: item.path, line: index + 1, text: clip(lines[index], 500) });
      }
    }
  }
  return { query, matches, truncated: matches.length >= maxResults };
}

function previewStatus() {
  const mode = PREVIEW_COMMAND ? 'command' : 'static';
  const running = mode === 'command' ? Boolean(previewProcess && previewProcess.exitCode === null) : Boolean(previewServer);
  return { running, mode, url: PREVIEW_URL, startedAt: running ? previewStartedAt : null, command: PREVIEW_COMMAND || null };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) client.write(payload);
}

async function startPreview() {
  if (previewStatus().running) return previewStatus();
  previewStartedAt = new Date().toISOString();

  if (PREVIEW_COMMAND) {
    previewProcess = spawn(PREVIEW_COMMAND, {
      cwd: PROJECT_PATH,
      env: process.env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    previewProcess.stdout.on('data', (chunk) => broadcast('preview-log', { stream: 'stdout', text: clip(chunk, 4_000) }));
    previewProcess.stderr.on('data', (chunk) => broadcast('preview-log', { stream: 'stderr', text: clip(chunk, 4_000) }));
    previewProcess.once('exit', (code, signal) => {
      previewProcess = null;
      previewStartedAt = null;
      broadcast('preview-status', { ...previewStatus(), exitCode: code, signal });
    });
  } else {
    const staticApp = express();
    staticApp.use(express.static(PROJECT_PATH, { extensions: ['html'], index: ['index.html'] }));
    await new Promise((resolve, reject) => {
      const server = staticApp.listen(PREVIEW_PORT, '127.0.0.1', resolve);
      server.once('error', reject);
      previewServer = server;
    });
  }
  const status = previewStatus();
  broadcast('preview-status', status);
  return status;
}

async function stopPreview() {
  if (previewProcess) {
    const child = previewProcess;
    previewProcess = null;
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => child.kill());
    } else {
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3_000).unref();
    }
  }
  if (previewServer) {
    const server = previewServer;
    previewServer = null;
    await new Promise((resolve) => server.close(resolve));
  }
  previewStartedAt = null;
  const status = previewStatus();
  broadcast('preview-status', status);
  return status;
}

async function controlPreview(action) {
  if (action === 'status') return previewStatus();
  if (action === 'start') return startPreview();
  if (action === 'stop') return stopPreview();
  if (action === 'restart') {
    await stopPreview();
    return startPreview();
  }
  throw createHttpError(400, `Unknown preview action: ${action}`);
}

function createMcpServer() {
  const server = new McpServer({ name: 'todo-local-dev', version: '1.1.0' });

  server.registerTool('project_info', {
    title: 'Project information',
    description: 'Return the configured project, repository, preview, and safety limits.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => jsonResult({
    projectPath: PROJECT_PATH,
    repoPath: REPO_PATH,
    preview: previewStatus(),
    limits: { maxFileBytes: MAX_FILE_BYTES, maxReadBytes: MAX_READ_BYTES },
  }));

  server.registerTool('list_files', {
    title: 'List project files',
    description: 'List files and directories inside PROJECT_PATH. Sensitive paths are omitted.',
    inputSchema: {
      path: z.string().default('.').describe('Project-relative directory path.'),
      depth: z.number().int().min(0).max(20).default(4),
      limit: z.number().int().min(1).max(1000).default(300),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path: relativePath, depth, limit }) => {
    try { return jsonResult(await listProjectFiles(relativePath, depth, limit)); } catch (error) { return errorResult(error); }
  });

  server.registerTool('read_file', {
    title: 'Read project file',
    description: 'Read a UTF-8 text file from PROJECT_PATH and return its SHA-256 for safe subsequent edits.',
    inputSchema: { path: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path: relativePath }) => {
    try { return jsonResult(await readTextFile(relativePath)); } catch (error) { return errorResult(error); }
  });

  server.registerTool('write_file', {
    title: 'Write project file',
    description: 'Create or atomically overwrite a UTF-8 project file. Optionally require an expected SHA-256 to prevent stale writes.',
    inputSchema: {
      path: z.string().min(1),
      content: z.string(),
      overwrite: z.boolean().default(true),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ path: relativePath, content, overwrite, expectedSha256 }) => {
    try { return jsonResult(await writeTextFile(relativePath, content, { overwrite, expectedSha256 })); } catch (error) { return errorResult(error); }
  });

  server.registerTool('replace_in_file', {
    title: 'Replace text in project file',
    description: 'Replace exact text in a UTF-8 project file, with optional replace-all and SHA-256 concurrency protection.',
    inputSchema: {
      path: z.string().min(1),
      search: z.string().min(1),
      replacement: z.string(),
      replaceAll: z.boolean().default(false),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ path: relativePath, search, replacement, replaceAll, expectedSha256 }) => {
    try {
      const file = await readTextFile(relativePath);
      if (expectedSha256 && expectedSha256 !== file.sha256) throw createHttpError(409, 'File changed since it was read.');
      const occurrences = file.content.split(search).length - 1;
      if (occurrences === 0) throw createHttpError(404, 'Search text was not found.');
      const content = replaceAll ? file.content.split(search).join(replacement) : file.content.replace(search, replacement);
      const written = await writeTextFile(relativePath, content, { overwrite: true, expectedSha256: file.sha256 });
      return jsonResult({ ...written, replacements: replaceAll ? occurrences : 1 });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('search_files', {
    title: 'Search project text',
    description: 'Search UTF-8 project files for case-insensitive text.',
    inputSchema: {
      query: z.string().min(1),
      fileSuffix: z.string().default('').describe('Optional suffix such as .js or .html.'),
      maxResults: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, fileSuffix, maxResults }) => {
    try { return jsonResult(await searchProject(query, fileSuffix, maxResults)); } catch (error) { return errorResult(error); }
  });

  server.registerTool('delete_path', {
    title: 'Delete project path',
    description: 'Delete one project file or directory recursively. The root and sensitive paths are blocked.',
    inputSchema: { path: z.string().min(1), recursive: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ path: relativePath, recursive }) => {
    try {
      const safe = await resolveProjectPath(relativePath);
      const stat = await fs.lstat(safe.absolute);
      if (stat.isDirectory() && !recursive) throw createHttpError(400, 'Set recursive=true to delete a directory.');
      await fs.rm(safe.absolute, { recursive, force: false });
      broadcast('file-change', { event: 'delete', path: safe.relative, at: new Date().toISOString() });
      return jsonResult({ deleted: safe.relative });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('git_status', {
    title: 'Git status',
    description: 'Return branch, tracking, and working-tree status.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => { try { return jsonResult(await gitStatus()); } catch (error) { return errorResult(error); } });

  server.registerTool('git_diff', {
    title: 'Git diff',
    description: 'Return the current Git diff, optionally staged and optionally for one project-relative path.',
    inputSchema: { staged: z.boolean().default(false), path: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ staged, path: relativePath }) => {
    try {
      const args = ['diff'];
      if (staged) args.push('--cached');
      if (relativePath) {
        const safe = await resolveProjectPath(relativePath, { allowMissing: true });
        args.push('--', safe.relative);
      }
      return jsonResult({ diff: await git(args) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('git_pull', {
    title: 'Git pull',
    description: 'Pull the configured repository using fast-forward only.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async () => { try { return jsonResult({ output: await git(['pull', '--ff-only']) }); } catch (error) { return errorResult(error); } });

  server.registerTool('git_commit', {
    title: 'Git commit',
    description: 'Stage all changes and create a local Git commit.',
    inputSchema: { message: z.string().min(1).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ message }) => {
    try {
      await git(['add', '--all']);
      return jsonResult({ output: await git(['commit', '-m', message.trim()]) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('git_push', {
    title: 'Git push',
    description: 'Push committed changes to the configured upstream repository.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async () => { try { return jsonResult({ output: await git(['push']) }); } catch (error) { return errorResult(error); } });

  server.registerTool('preview_control', {
    title: 'Preview control',
    description: 'Get status or start, stop, or restart the local preview server.',
    inputSchema: { action: z.enum(['status', 'start', 'stop', 'restart']).default('status') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action }) => { try { return jsonResult(await controlPreview(action)); } catch (error) { return errorResult(error); } });

  return server;
}

function extensionAuth(req, res, next) {
  const expected = activeExtensionToken();
  if (!expected) return res.status(503).json({ error: 'Extension token is not configured yet. Set it from the side panel first.' });
  const supplied = req.get('X-Extension-Token') || req.query.token || '';
  if (!timingSafeTokenEqual(expected, String(supplied))) return res.status(401).json({ error: 'Invalid server token.' });
  next();
}

function mcpAuth(req, res, next) {
  if (ALLOW_UNAUTHENTICATED_MCP) return next();
  if (!MCP_TOKEN) return res.status(503).json({ error: 'MCP authentication is required. Set MCP_TOKEN or ALLOW_UNAUTHENTICATED_MCP=true.' });
  const authorization = req.get('Authorization') || '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!timingSafeTokenEqual(MCP_TOKEN, supplied)) return res.status(401).json({ error: 'Invalid MCP bearer token.' });
  next();
}

function validateOrigin(req, res, next) {
  const origin = req.get('Origin');
  if (!origin) return next();
  const configured = String(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const allowed = configured.includes(origin)
    || /^chrome-extension:\/\/[a-p]{32}$/i.test(origin)
    || /^https:\/\/([a-z0-9-]+\.)?(chatgpt\.com|openai\.com)$/i.test(origin)
    || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
  if (!allowed) return res.status(403).json({ error: `Origin is not allowed: ${origin}` });
  next();
}

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin || /^chrome-extension:\/\//i.test(origin) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return callback(null, true);
    callback(null, false);
  },
}));
app.use(express.json({ limit: `${Math.ceil(MAX_FILE_BYTES / 1024) + 256}kb` }));
app.use(validateOrigin);

app.get('/', (_req, res) => res.json({
  name: 'todo-local-dev',
  version: '1.1.0',
  api: `http://127.0.0.1:${PORT}/api`,
  mcp: `http://127.0.0.1:${PORT}/mcp`,
  preview: previewStatus(),
  extensionAuth: extensionConfigStatus(),
}));

app.get('/api/config', (_req, res) => res.json(extensionConfigStatus()));
app.put('/api/config', async (req, res, next) => {
  try {
    const nextToken = String(req.body.extensionToken || '').trim();
    if (!nextToken) throw createHttpError(400, 'Extension token must not be empty.');
    if (nextToken.length < 12) throw createHttpError(400, 'Extension token must be at least 12 characters.');

    const currentToken = activeExtensionToken();
    const supplied = String(req.get('X-Extension-Token') || req.query.token || '');
    if (currentToken && !timingSafeTokenEqual(currentToken, supplied)) {
      throw createHttpError(401, 'Current server token is required to update the extension token.');
    }

    settings.extensionToken = nextToken;
    await saveSettings();
    res.json(extensionConfigStatus());
  } catch (error) { next(error); }
});

app.use('/api', extensionAuth);
app.get('/api/health', (_req, res) => res.json({ ok: true, version: '1.1.0', preview: previewStatus() }));
app.get('/api/settings', (_req, res) => res.json(publicSettings()));
app.put('/api/settings', async (req, res, next) => {
  try {
    settings.autoSync = req.body.autoSync === true;
    await saveSettings();
    res.json(publicSettings());
  } catch (error) { next(error); }
});
app.get('/api/git/status', async (_req, res, next) => { try { res.json(await gitStatus()); } catch (error) { next(error); } });
app.post('/api/git/pull', async (_req, res, next) => { try { res.json({ output: await git(['pull', '--ff-only']) }); } catch (error) { next(error); } });
app.post('/api/git/push', async (_req, res, next) => { try { res.json({ output: await git(['push']) }); } catch (error) { next(error); } });
app.post('/api/git/commit', async (req, res, next) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message || message.length > 200) throw createHttpError(400, 'Commit message must be 1–200 characters.');
    await git(['add', '--all']);
    res.json({ output: await git(['commit', '-m', message]) });
  } catch (error) { next(error); }
});
app.get('/api/preview/status', (_req, res) => res.json(previewStatus()));
app.post('/api/preview/:action', async (req, res, next) => { try { res.json(await controlPreview(req.params.action)); } catch (error) { next(error); } });
app.get('/api/mcp/status', (_req, res) => res.json({
  endpoint: `http://127.0.0.1:${PORT}/mcp`,
  transport: 'Streamable HTTP',
  toolCount: MCP_TOOL_COUNT,
  authentication: ALLOW_UNAUTHENTICATED_MCP ? 'none' : MCP_TOKEN ? 'bearer' : 'not configured',
  ready: ALLOW_UNAUTHENTICATED_MCP || Boolean(MCP_TOKEN),
}));
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  eventClients.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ preview: previewStatus() })}\n\n`);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
  });
});

app.options('/mcp', (_req, res) => res.sendStatus(204));
app.post('/mcp', mcpAuth, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});
app.get('/mcp', mcpAuth, (_req, res) => res.status(405).set('Allow', 'POST, OPTIONS').json({ error: 'This server uses stateless Streamable HTTP. Send MCP messages with POST.' }));
app.delete('/mcp', mcpAuth, (_req, res) => res.status(405).set('Allow', 'POST, OPTIONS').json({ error: 'Stateless sessions do not support DELETE.' }));

app.use((error, _req, res, _next) => {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  else console.warn(error.message);
  res.status(status).json({ error: error.message || 'Operation failed.' });
});

async function autoSync() {
  if (!settings.autoSync || syncRunning) return;
  syncRunning = true;
  try {
    const status = await gitStatus();
    if (!status.clean) return;
    await git(['pull', '--ff-only']);
    await git(['push']);
  } catch (error) {
    console.error('Auto sync failed:', error.message);
  } finally {
    syncRunning = false;
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down…`);
  await stopPreview().catch(() => undefined);
  await watcher.close().catch(() => undefined);
  process.exit(0);
}

await loadSettings();
const watcher = chokidar.watch(PROJECT_PATH, {
  ignoreInitial: true,
  ignored: [/(^|[\\/])\.git([\\/]|$)/, /(^|[\\/])node_modules([\\/]|$)/],
  awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
});
let changeTimer = null;
watcher.on('all', (event, changedPath) => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const relative = path.relative(PROJECT_PATH, changedPath).replaceAll('\\', '/');
    if (!isSensitiveRelativePath(relative)) broadcast('file-change', { event, path: relative, at: new Date().toISOString() });
  }, 80);
});

setInterval(autoSync, AUTO_SYNC_INTERVAL_MS).unref();
setInterval(() => broadcast('heartbeat', { at: new Date().toISOString() }), 25_000).unref();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Developer server: http://127.0.0.1:${PORT}`);
  console.log(`MCP endpoint:    http://127.0.0.1:${PORT}/mcp`);
  console.log(`Project:         ${PROJECT_PATH}`);
  console.log(`Repository:      ${REPO_PATH}`);
  console.log(`Extension auth:  ${extensionTokenSource() === 'ui' ? 'UI token' : extensionTokenSource() === 'env' ? '.env token' : 'NOT CONFIGURED'}`);
  console.log(`MCP auth:        ${ALLOW_UNAUTHENTICATED_MCP ? 'disabled (development only)' : MCP_TOKEN ? 'Bearer token' : 'NOT CONFIGURED'}`);
});
