const $ = (id) => document.getElementById(id);

const form = $('urlForm');
const input = $('urlInput');
const frame = $('previewFrame');
const message = $('message');
const previewArea = $('previewArea');
const collapseButton = $('collapseButton');
const currentTabButton = $('currentTabButton');
const openTabButton = $('openTabButton');
const serverToken = $('serverToken');
const saveServerTokenButton = $('saveServerTokenButton');
const serverTokenStatus = $('serverTokenStatus');
const serverStatus = $('serverStatus');
const gitBranch = $('gitBranch');
const gitChanges = $('gitChanges');
const gitTracking = $('gitTracking');
const autoSyncToggle = $('autoSyncToggle');
const refreshGitButton = $('refreshGitButton');
const pullButton = $('pullButton');
const pushButton = $('pushButton');
const commitMessage = $('commitMessage');
const commitButton = $('commitButton');
const gitOutput = $('gitOutput');
const livePreviewStatus = $('livePreviewStatus');
const startPreviewButton = $('startPreviewButton');
const restartPreviewButton = $('restartPreviewButton');
const stopPreviewButton = $('stopPreviewButton');
const refreshMcpButton = $('refreshMcpButton');
const mcpStatus = $('mcpStatus');
const mcpTransport = $('mcpTransport');
const mcpTools = $('mcpTools');
const mcpAuth = $('mcpAuth');
const localMcpUrl = $('localMcpUrl');
const tunnelMcpUrl = $('tunnelMcpUrl');
const copyLocalMcpButton = $('copyLocalMcpButton');
const copyTunnelMcpButton = $('copyTunnelMcpButton');
const mcpOutput = $('mcpOutput');
const API_URL = 'http://127.0.0.1:4783/api';

const views = {
  preview: { tab: $('previewTab'), panel: $('previewView') },
  git: { tab: $('gitTab'), panel: $('gitView') },
  mcp: { tab: $('mcpTab'), panel: $('mcpView') },
};

let currentUrl = '';
let eventSource = null;
let reloadTimer = null;
let currentAuthToken = '';

async function selectView(view, persist = true) {
  const selected = views[view] ? view : 'preview';
  for (const [name, item] of Object.entries(views)) {
    const active = name === selected;
    item.tab.classList.toggle('active', active);
    item.tab.setAttribute('aria-selected', String(active));
    item.panel.hidden = !active;
  }
  if (persist) await chrome.storage.local.set({ activeView: selected });
  if (selected === 'git') refreshGit();
  if (selected === 'mcp') refreshMcp();
}

for (const [name, item] of Object.entries(views)) item.tab.addEventListener('click', () => selectView(name));

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

function reloadPreview() {
  if (!currentUrl || previewArea.classList.contains('collapsed')) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const url = new URL(currentUrl);
    url.searchParams.set('__live_reload', Date.now());
    frame.src = url.href;
  }, 120);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  preview(input.value);
});

frame.addEventListener('load', () => {
  if (currentUrl) setMessage('Preview loaded. File changes will refresh this frame.');
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
    chrome.tabs.create({ url: normalizeUrl(input.value || currentUrl) });
  } catch (error) {
    setMessage(error.message, true);
  }
});

async function api(path, options = {}) {
  const token = currentAuthToken;
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Extension-Token': token, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function publicApi(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function setServerTokenStatus(text, isError = false) {
  serverTokenStatus.textContent = text;
  serverTokenStatus.classList.toggle('offline', isError);
}

function describeTokenConfig(config) {
  if (!config.configured) return 'No server token is set yet. Enter one here and click Save.';
  if (!currentAuthToken) return `Server token is configured from ${config.source}. Enter that token here and click Save to connect this side panel.`;
  return `Connected with the ${config.source} server token.`;
}

async function refreshConfigStatus() {
  try {
    const config = await publicApi('/config');
    setServerTokenStatus(describeTokenConfig(config));
    return config;
  } catch (error) {
    setServerTokenStatus(error.message, true);
    throw error;
  }
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
    showGitOutput(result.output || result.message || result);
    await refreshGit();
  } catch (error) {
    showGitOutput(error.message);
  }
}

function setLivePreviewStatus(status) {
  livePreviewStatus.textContent = status.running ? `Running · ${status.url}` : 'Stopped';
  startPreviewButton.disabled = status.running;
  restartPreviewButton.disabled = !status.running;
  stopPreviewButton.disabled = !status.running;
}

async function previewAction(action) {
  try {
    livePreviewStatus.textContent = `${action[0].toUpperCase()}${action.slice(1)}ing…`;
    const status = await api(`/preview/${action}`, { method: 'POST' });
    setLivePreviewStatus(status);
    if ((action === 'start' || action === 'restart') && status.url) preview(status.url);
  } catch (error) {
    livePreviewStatus.textContent = error.message;
  }
}

function connectLiveEvents() {
  eventSource?.close();
  const token = encodeURIComponent(currentAuthToken);
  if (!token) return;
  eventSource = new EventSource(`${API_URL}/events?token=${token}`);
  eventSource.addEventListener('connected', (event) => setLivePreviewStatus(JSON.parse(event.data).preview));
  eventSource.addEventListener('preview-status', (event) => setLivePreviewStatus(JSON.parse(event.data)));
  eventSource.addEventListener('file-change', reloadPreview);
  eventSource.addEventListener('preview-log', (event) => {
    const payload = JSON.parse(event.data);
    setMessage(payload.text.trim() || 'Preview process update.');
  });
  eventSource.onerror = () => { livePreviewStatus.textContent = 'Live server disconnected'; };
}

async function refreshMcp() {
  try {
    const status = await api('/mcp/status');
    localMcpUrl.value = status.endpoint;
    mcpTransport.textContent = status.transport;
    mcpTools.textContent = String(status.toolCount);
    mcpAuth.textContent = status.authentication;
    mcpStatus.textContent = status.ready ? 'MCP server ready' : 'MCP auth not configured';
    mcpStatus.classList.toggle('offline', !status.ready);
    mcpOutput.textContent = status.ready
      ? `Local MCP endpoint is ready.\n\nFor ChatGPT Web, expose port 4783 through HTTPS and register the tunnel URL ending in /mcp.`
      : 'Set MCP_TOKEN, or temporarily enable ALLOW_UNAUTHENTICATED_MCP for isolated developer-mode testing.';
  } catch (error) {
    mcpStatus.textContent = 'Server offline or token invalid';
    mcpStatus.classList.add('offline');
    mcpOutput.textContent = error.message;
  }
}

async function copyValue(inputElement, button) {
  const value = inputElement.value.trim();
  if (!value) return;
  await navigator.clipboard.writeText(value);
  const previous = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = previous; }, 1_200);
}

startPreviewButton.addEventListener('click', () => previewAction('start'));
restartPreviewButton.addEventListener('click', () => previewAction('restart'));
stopPreviewButton.addEventListener('click', () => previewAction('stop'));
refreshGitButton.addEventListener('click', refreshGit);
refreshMcpButton.addEventListener('click', refreshMcp);
copyLocalMcpButton.addEventListener('click', () => copyValue(localMcpUrl, copyLocalMcpButton));
copyTunnelMcpButton.addEventListener('click', () => copyValue(tunnelMcpUrl, copyTunnelMcpButton));

async function saveServerToken() {
  const nextToken = serverToken.value.trim();
  if (!nextToken) {
    setServerTokenStatus('Enter a token before saving.', true);
    return;
  }

  saveServerTokenButton.disabled = true;
  setServerTokenStatus('Saving token…');
  try {
    await publicApi('/config', {
      method: 'PUT',
      headers: currentAuthToken || nextToken ? { 'X-Extension-Token': currentAuthToken || nextToken } : {},
      body: JSON.stringify({ extensionToken: nextToken }),
    });
    currentAuthToken = nextToken;
    await chrome.storage.local.set({ serverToken: currentAuthToken });
    connectLiveEvents();
    await Promise.allSettled([refreshConfigStatus(), refreshGit(), refreshMcp()]);
    setServerTokenStatus('Server token saved. This side panel is now using it.');
  } catch (error) {
    setServerTokenStatus(error.message, true);
  } finally {
    saveServerTokenButton.disabled = false;
  }
}

serverToken.addEventListener('input', () => {
  if (serverToken.value.trim() === currentAuthToken) {
    setServerTokenStatus('Saved token loaded.');
    return;
  }
  setServerTokenStatus('Unsaved token change. Click Save to update the server.');
});
saveServerTokenButton.addEventListener('click', saveServerToken);

tunnelMcpUrl.addEventListener('change', async () => {
  await chrome.storage.local.set({ tunnelMcpUrl: tunnelMcpUrl.value.trim() });
});

pullButton.addEventListener('click', () => runGitAction('/git/pull'));
pushButton.addEventListener('click', () => runGitAction('/git/push'));
commitButton.addEventListener('click', () => {
  const commit = commitMessage.value.trim();
  if (!commit) return showGitOutput('Enter a commit message.');
  runGitAction('/git/commit', { message: commit }).then(() => { commitMessage.value = ''; });
});
autoSyncToggle.addEventListener('change', async () => {
  try {
    const updated = await api('/settings', { method: 'PUT', body: JSON.stringify({ autoSync: autoSyncToggle.checked }) });
    showGitOutput(`Auto sync ${updated.autoSync ? 'enabled' : 'disabled'}.`);
  } catch (error) {
    autoSyncToggle.checked = false;
    showGitOutput(error.message);
  }
});

(async () => {
  const saved = await chrome.storage.local.get(['lastUrl', 'collapsed', 'serverToken', 'activeView', 'tunnelMcpUrl']);
  currentAuthToken = saved.serverToken || '';
  serverToken.value = currentAuthToken;
  tunnelMcpUrl.value = saved.tunnelMcpUrl || '';
  if (saved.collapsed) {
    previewArea.classList.add('collapsed');
    collapseButton.textContent = '+';
    collapseButton.title = 'Expand preview';
    collapseButton.setAttribute('aria-expanded', 'false');
  }
  await refreshConfigStatus().catch(() => undefined);
  connectLiveEvents();
  if (saved.lastUrl) preview(saved.lastUrl);
  await selectView(saved.activeView || 'preview', false);
})();
