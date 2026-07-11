(() => {
  'use strict';

  const API_URL = 'http://127.0.0.1:4783/api';
  const $ = (id) => document.getElementById(id);

  const elements = {
    tab: $('mcpTab'),
    refresh: $('refreshMcpButton'),
    status: $('mcpStatus'),
    version: $('mcpVersion'),
    transport: $('mcpTransport'),
    tools: $('mcpTools'),
    auth: $('mcpAuth'),
    preview: $('mcpPreview'),
    autoSync: $('mcpAutoSync'),
    localUrl: $('localMcpUrl'),
    tunnelUrl: $('tunnelMcpUrl'),
    configButton: $('copyMcpConfigButton'),
    configPreview: $('mcpConfigPreview'),
    apiEndpoint: $('mcpApiEndpoint'),
    branch: $('mcpBranch'),
    changes: $('mcpChanges'),
    tracking: $('mcpTracking'),
    previewMode: $('mcpPreviewMode'),
    previewUrl: $('mcpPreviewUrl'),
    previewStarted: $('mcpPreviewStarted'),
    lastChecked: $('mcpLastChecked'),
    checklist: $('mcpChecklist'),
    toolList: $('mcpToolList'),
    toolCount: $('mcpToolCountBadge'),
    output: $('mcpOutput'),
    serverToken: $('serverToken'),
  };

  const TOOL_CATALOG = [
    ['project_info', 'read', 'Project, repository, preview, and safety-limit information.'],
    ['list_files', 'read', 'List project files and directories while omitting sensitive paths.'],
    ['read_file', 'read', 'Read UTF-8 files with SHA-256 metadata for safe edits.'],
    ['write_file', 'write', 'Create or atomically overwrite a file with conflict protection.'],
    ['replace_in_file', 'write', 'Replace exact text with optional replace-all and SHA checks.'],
    ['search_files', 'read', 'Search project text with an optional file suffix filter.'],
    ['delete_path', 'write', 'Delete a project file or directory; sensitive paths are blocked.'],
    ['git_status', 'read', 'Read branch, upstream, ahead/behind, and working-tree status.'],
    ['git_diff', 'read', 'Inspect staged or unstaged Git differences.'],
    ['git_pull', 'write', 'Pull from the configured upstream with fast-forward only.'],
    ['git_commit', 'write', 'Stage all changes and create a local commit.'],
    ['git_push', 'write', 'Push committed changes to the configured upstream.'],
    ['preview_control', 'write', 'Inspect, start, stop, or restart the local preview process.'],
  ];

  let latestMcpStatus = null;

  async function request(path) {
    const response = await fetch(`${API_URL}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Token': elements.serverToken.value.trim(),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function settledValue(result, fallback = null) {
    return result.status === 'fulfilled' ? result.value : fallback;
  }

  function formatDate(value) {
    if (!value) return 'Not running';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function renderTools(serverToolCount = TOOL_CATALOG.length) {
    elements.toolList.replaceChildren();
    for (const [name, access, description] of TOOL_CATALOG) {
      const row = document.createElement('li');
      row.className = 'tool-item';

      const main = document.createElement('div');
      main.className = 'tool-main';

      const code = document.createElement('code');
      code.textContent = name;

      const text = document.createElement('span');
      text.textContent = description;

      const badge = document.createElement('span');
      badge.className = `tool-badge${access === 'write' ? ' write' : ''}`;
      badge.textContent = access;

      main.append(code, text);
      row.append(main, badge);
      elements.toolList.appendChild(row);
    }
    elements.toolCount.textContent = String(serverToolCount);
  }

  function renderChecklist(items) {
    elements.checklist.replaceChildren();
    for (const item of items) {
      const row = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `status-dot${item.level === 'ok' ? ' ok' : item.level === 'warn' ? ' warn' : ''}`;
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = item.text;
      row.append(dot, text);
      elements.checklist.appendChild(row);
    }
  }

  function connectionConfig(status = latestMcpStatus) {
    const url = elements.tunnelUrl.value.trim() || status?.endpoint || elements.localUrl.value;
    const config = {
      name: 'Todo Local MCP',
      url,
      transport: 'streamable_http',
    };
    config.authentication = status?.authentication === 'bearer'
      ? { type: 'bearer', token: '<MCP_TOKEN from extension/server/.env>' }
      : { type: 'none' };
    return config;
  }

  function updateConfigPreview() {
    elements.configPreview.textContent = JSON.stringify(connectionConfig(), null, 2);
  }

  async function copyConfig() {
    await navigator.clipboard.writeText(JSON.stringify(connectionConfig(), null, 2));
    const previous = elements.configButton.textContent;
    elements.configButton.textContent = 'Config copied';
    setTimeout(() => { elements.configButton.textContent = previous; }, 1200);
  }

  async function refreshFullInfo() {
    elements.refresh.disabled = true;
    elements.status.textContent = 'Checking local server…';
    elements.status.classList.add('checking');
    elements.status.classList.remove('offline');

    const results = await Promise.allSettled([
      request('/mcp/status'),
      request('/health'),
      request('/settings'),
      request('/git/status'),
      request('/preview/status'),
    ]);

    const mcp = settledValue(results[0]);
    const health = settledValue(results[1]);
    const settings = settledValue(results[2]);
    const git = settledValue(results[3]);
    const preview = settledValue(results[4], health?.preview || null);
    const checkedAt = new Date();

    elements.refresh.disabled = false;
    elements.status.classList.remove('checking');
    elements.lastChecked.textContent = checkedAt.toLocaleString();

    if (!mcp) {
      const error = results.find((result) => result.status === 'rejected')?.reason;
      elements.status.textContent = 'Server offline or extension token invalid';
      elements.status.classList.add('offline');
      elements.version.textContent = 'Offline';
      elements.transport.textContent = '—';
      elements.tools.textContent = '—';
      elements.auth.textContent = '—';
      elements.preview.textContent = '—';
      elements.autoSync.textContent = '—';
      renderChecklist([
        { level: 'error', text: 'Local server is not reachable with the saved EXTENSION_TOKEN.' },
        { level: elements.tunnelUrl.value.trim() ? 'ok' : 'warn', text: elements.tunnelUrl.value.trim() ? 'HTTPS tunnel URL is saved.' : 'HTTPS tunnel URL is not configured.' },
      ]);
      elements.output.textContent = error?.message || 'Unable to reach the local MCP server.';
      latestMcpStatus = null;
      updateConfigPreview();
      return;
    }

    latestMcpStatus = mcp;
    const ready = mcp.ready === true;
    const previewRunning = preview?.running === true;
    const authLabel = mcp.authentication === 'bearer'
      ? 'Bearer token'
      : mcp.authentication === 'none'
        ? 'None (development)'
        : 'Not configured';

    elements.localUrl.value = mcp.endpoint || elements.localUrl.value;
    elements.version.textContent = health?.version ? `v${health.version}` : 'Unknown';
    elements.transport.textContent = mcp.transport || 'Unknown';
    elements.tools.textContent = String(mcp.toolCount ?? TOOL_CATALOG.length);
    elements.auth.textContent = authLabel;
    elements.preview.textContent = previewRunning ? 'Running' : 'Stopped';
    elements.autoSync.textContent = settings?.autoSync ? 'Enabled' : 'Disabled';
    elements.apiEndpoint.textContent = API_URL;
    elements.branch.textContent = git?.branch || 'Unavailable';
    elements.changes.textContent = Number.isInteger(git?.changedFiles) ? String(git.changedFiles) : 'Unavailable';
    elements.tracking.textContent = git ? `${git.ahead || 0} / ${git.behind || 0}` : 'Unavailable';
    elements.previewMode.textContent = preview?.mode || 'Unknown';
    elements.previewUrl.textContent = preview?.url || 'Unavailable';
    elements.previewStarted.textContent = formatDate(preview?.startedAt);

    elements.status.textContent = ready ? 'MCP server ready' : 'MCP authentication is not configured';
    elements.status.classList.toggle('offline', !ready);

    renderTools(mcp.toolCount ?? TOOL_CATALOG.length);
    renderChecklist([
      { level: 'ok', text: `Local API connected at ${API_URL}.` },
      { level: 'ok', text: 'Saved EXTENSION_TOKEN was accepted.' },
      { level: ready ? 'ok' : 'error', text: ready ? `MCP authentication mode: ${authLabel}.` : 'Set MCP_TOKEN in extension/server/.env.' },
      { level: previewRunning ? 'ok' : 'warn', text: previewRunning ? `Preview is running at ${preview.url}.` : 'Preview is stopped; start it from the Preview tab when needed.' },
      { level: elements.tunnelUrl.value.trim() ? 'ok' : 'warn', text: elements.tunnelUrl.value.trim() ? 'HTTPS tunnel endpoint is saved for ChatGPT.' : 'Add an HTTPS tunnel URL ending in /mcp for ChatGPT Developer Mode.' },
    ]);

    elements.output.textContent = JSON.stringify({
      checkedAt: checkedAt.toISOString(),
      mcp,
      health,
      settings,
      git,
      preview,
      tools: TOOL_CATALOG.map(([name, access]) => ({ name, access })),
    }, null, 2);
    updateConfigPreview();
  }

  renderTools();
  updateConfigPreview();
  elements.refresh.addEventListener('click', refreshFullInfo);
  elements.tab.addEventListener('click', () => setTimeout(refreshFullInfo, 0));
  elements.serverToken.addEventListener('change', () => setTimeout(refreshFullInfo, 0));
  elements.tunnelUrl.addEventListener('input', updateConfigPreview);
  elements.configButton.addEventListener('click', copyConfig);

  chrome.storage.local.get(['activeView']).then(({ activeView }) => {
    if (activeView === 'mcp') refreshFullInfo();
  });
})();
