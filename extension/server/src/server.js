import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();
const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT || 4783);
const REPO_PATH = path.resolve(process.env.REPO_PATH || '.');
const TOKEN = process.env.EXTENSION_TOKEN || '';
const SETTINGS_FILE = path.resolve('settings.json');
const intervalMs = Math.max(1, Number(process.env.AUTO_SYNC_INTERVAL_MINUTES || 5)) * 60_000;
let settings = { autoSync: false };
let syncRunning = false;

function createGitConfigError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function formatGitError(error) {
  const details = `${error?.stderr || ''}\n${error?.stdout || ''}\n${error?.message || ''}`.trim();
  if (details.includes('not a git repository')) {
    return createGitConfigError(`REPO_PATH is not a git repository: ${REPO_PATH}`);
  }
  if (details.includes('ENOENT') || details.includes('no such file or directory')) {
    return createGitConfigError(`REPO_PATH does not exist or is not accessible: ${REPO_PATH}`);
  }
  return error;
}

app.use(cors({ origin: (_origin, callback) => callback(null, true) }));
app.use(express.json({ limit: '16kb' }));

app.use('/api', (req, res, next) => {
  if (!TOKEN) return res.status(503).json({ error: 'EXTENSION_TOKEN is not configured.' });
  const supplied = req.get('X-Extension-Token') || '';
  const valid = supplied.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(TOKEN));
  if (!valid) return res.status(401).json({ error: 'Invalid server token.' });
  next();
});

async function git(args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd: REPO_PATH, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    throw formatGitError(error);
  }
}

async function saveSettings() {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

async function loadSettings() {
  try {
    settings = { autoSync: false, ...JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) };
  } catch {
    settings = { autoSync: false };
    await saveSettings();
  }
}

app.get('/api/settings', (_req, res) => res.json(settings));
app.put('/api/settings', async (req, res, next) => {
  try {
    settings.autoSync = req.body.autoSync === true;
    await saveSettings();
    res.json(settings);
  } catch (error) { next(error); }
});

app.get('/api/git/status', async (_req, res, next) => {
  try {
    const output = await git(['status', '--porcelain=v2', '--branch']);
    const branch = output.match(/^# branch\.head (.+)$/m)?.[1] || '';
    const aheadBehind = output.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
    const changes = output.split('\n').filter((line) => /^[12?u] /.test(line));
    res.json({ branch, ahead: Number(aheadBehind?.[1] || 0), behind: Number(aheadBehind?.[2] || 0), changedFiles: changes.length, summary: changes.join('\n') });
  } catch (error) { next(error); }
});

app.post('/api/git/pull', async (_req, res, next) => {
  try { res.json({ output: await git(['pull', '--ff-only']) }); } catch (error) { next(error); }
});
app.post('/api/git/push', async (_req, res, next) => {
  try { res.json({ output: await git(['push']) }); } catch (error) { next(error); }
});
app.post('/api/git/commit', async (req, res, next) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message || message.length > 200) return res.status(400).json({ error: 'Commit message must be 1–200 characters.' });
    await git(['add', '--all']);
    res.json({ output: await git(['commit', '-m', message]) });
  } catch (error) { next(error); }
});

async function autoSync() {
  if (!settings.autoSync || syncRunning) return;
  syncRunning = true;
  try {
    const dirty = await git(['status', '--porcelain']);
    if (dirty) return;
    await git(['pull', '--ff-only']);
    await git(['push']);
  } catch (error) {
    if (error.statusCode === 400) {
      console.warn('Auto sync skipped:', error.message);
    } else {
      console.error('Auto sync failed:', error.message);
    }
  } finally { syncRunning = false; }
}

app.use((error, _req, res, _next) => {
  if (error.statusCode === 400) {
    console.warn(error.message);
  } else {
    console.error(error);
  }
  res.status(error.statusCode || 500).json({ error: error.stderr?.trim() || error.message || 'Git operation failed.' });
});

await loadSettings();
setInterval(autoSync, intervalMs).unref();
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Git server: http://127.0.0.1:${PORT}`);
  console.log(`Repository: ${REPO_PATH}`);
  console.log(`Auto sync: ${settings.autoSync ? 'on' : 'off'}`);
});
