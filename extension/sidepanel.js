const form = document.getElementById('urlForm');
const input = document.getElementById('urlInput');
const frame = document.getElementById('previewFrame');
const message = document.getElementById('message');
const previewArea = document.getElementById('previewArea');
const collapseButton = document.getElementById('collapseButton');
const currentTabButton = document.getElementById('currentTabButton');
const openTabButton = document.getElementById('openTabButton');
const serverToken = document.getElementById('serverToken');
const serverStatus = document.getElementById('serverStatus');
const gitBranch = document.getElementById('gitBranch');
const gitChanges = document.getElementById('gitChanges');
const gitTracking = document.getElementById('gitTracking');
const autoSyncToggle = document.getElementById('autoSyncToggle');
const refreshGitButton = document.getElementById('refreshGitButton');
const pullButton = document.getElementById('pullButton');
const pushButton = document.getElementById('pushButton');
const commitMessage = document.getElementById('commitMessage');
const commitButton = document.getElementById('commitButton');
const gitOutput = document.getElementById('gitOutput');
const API_URL = 'http://127.0.0.1:4783/api';
const previewTab = document.getElementById('previewTab');
const gitTab = document.getElementById('gitTab');
const previewView = document.getElementById('previewView');
const gitView = document.getElementById('gitView');

let currentUrl = '';

async function selectView(view, persist = true) {
  const showGit = view === 'git';
  previewTab.classList.toggle('active', !showGit);
  gitTab.classList.toggle('active', showGit);
  previewTab.setAttribute('aria-selected', String(!showGit));
  gitTab.setAttribute('aria-selected', String(showGit));
  previewView.hidden = showGit;
  gitView.hidden = !showGit;
  if (persist) await chrome.storage.local.set({ activeView: showGit ? 'git' : 'preview' });
  if (showGit) refreshGit();
}

previewTab.addEventListener('click', () => selectView('preview'));
gitTab.addEventListener('click', () => selectView('git'));

function normalizeUrl(value) {
  const candidate = value.trim();
  if (!candidate) throw new Error('Please enter a URL.');
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  return url.href;
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

async function preview(value) {
  try {
    currentUrl = normalizeUrl(value);
    input.value = currentUrl;
    frame.src = currentUrl;
    setMessage('Loading preview…');
    await chrome.storage.local.set({ lastUrl: currentUrl });
  } catch (error) {
    setMessage(error.message, true);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  preview(input.value);
});

frame.addEventListener('load', () => {
  if (currentUrl) setMessage('Preview loaded. Some websites may block iframe previews.');
});

collapseButton.addEventListener('click', async () => {
  const collapsed = !previewArea.classList.contains('collapsed');
  previewArea.classList.toggle('collapsed', collapsed);
  collapseButton.textContent = collapsed ? '+' : '−';
  collapseButton.title = collapsed ? 'Expand preview' : 'Collapse preview';
  collapseButton.setAttribute('aria-expanded', String(!collapsed));
  await chrome.storage.local.set({ collapsed });
});

currentTabButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    setMessage('The current tab cannot be previewed.', true);
    return;
  }
  preview(tab.url);
});

openTabButton.addEventListener('click', () => {
  try {
    const url = normalizeUrl(input.value || currentUrl);
    chrome.tabs.create({ url });
  } catch (error) {
    setMessage(error.message, true);
  }
});

async function api(path, options = {}) {
  const token = serverToken.value.trim();
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Extension-Token': token, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showGitOutput(value) {
  gitOutput.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function refreshGit() {
  try {
    const [status, settings] = await Promise.all([api('/git/status'), api('/settings')]);
    serverStatus.textContent = 'Server connected';
    serverStatus.classList.remove('offline');
    gitBranch.textContent = status.branch || 'detached';
    gitChanges.textContent = String(status.changedFiles);
    gitTracking.textContent = `${status.ahead} / ${status.behind}`;
    autoSyncToggle.checked = settings.autoSync;
    showGitOutput(status.summary || 'Working tree clean.');
  } catch (error) {
    serverStatus.textContent = 'Server offline or token invalid';
    serverStatus.classList.add('offline');
    showGitOutput(error.message);
  }
}

async function runGitAction(path, body) {
  try {
    showGitOutput('Working…');
    const result = await api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    showGitOutput(result.output || result.message);
    await refreshGit();
  } catch (error) {
    showGitOutput(error.message);
  }
}

serverToken.addEventListener('change', async () => {
  await chrome.storage.local.set({ serverToken: serverToken.value.trim() });
  refreshGit();
});
refreshGitButton.addEventListener('click', refreshGit);
pullButton.addEventListener('click', () => runGitAction('/git/pull'));
pushButton.addEventListener('click', () => runGitAction('/git/push'));
commitButton.addEventListener('click', () => {
  const message = commitMessage.value.trim();
  if (!message) return showGitOutput('Enter a commit message.');
  runGitAction('/git/commit', { message });
});
autoSyncToggle.addEventListener('change', async () => {
  try {
    const settings = await api('/settings', { method: 'PUT', body: JSON.stringify({ autoSync: autoSyncToggle.checked }) });
    showGitOutput(`Auto sync ${settings.autoSync ? 'enabled' : 'disabled'}.`);
  } catch (error) {
    autoSyncToggle.checked = false;
    showGitOutput(error.message);
  }
});

(async () => {
  const saved = await chrome.storage.local.get(['lastUrl', 'collapsed', 'serverToken', 'activeView']);
  serverToken.value = saved.serverToken || '';
  if (saved.collapsed) collapseButton.click();
  if (saved.lastUrl) preview(saved.lastUrl);
  await selectView(saved.activeView || 'preview', false);
})();
