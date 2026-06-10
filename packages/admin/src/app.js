const TOKEN_KEY = 'sudo-log-access-token';
const DEFAULT_TENANT_ID = 'sudo';
const DEFAULT_PRODUCT_ID = 'sudowork';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  rows: [],
  errorGroups: [],
  users: [],
  tenants: [],
  expandedTenants: new Set(),
  activeView: 'dashboard',
  grafana: {
    config: null,
    loading: false,
    customPanels: [],
  },
  detailTextSections: {},
  textDialog: {
    content: '',
    query: '',
    matchCount: 0,
    currentMatch: -1,
  },
};

const ids = [
  'loginView',
  'appView',
  'loginForm',
  'loginName',
  'loginPassword',
  'loginError',
  'currentUser',
  'logoutButton',
  'runQuery',
  'panelManagerOpen',
  'panelManagerBack',
  'pageTitle',
  'pageDescription',
  'filtersPanel',
  'tenant',
  'product',
  'level',
  'topic',
  'environment',
  'component',
  'version',
  'userId',
  'sessionId',
  'traceId',
  'tagSearch',
  'tagMode',
  'startTime',
  'endTime',
  'limit',
  'errorBanner',
  'metricsPanel',
  'metricRows',
  'metricErrors',
  'metricUsers',
  'metricGroups',
  'timeline',
  'timelinePanel',
  'timelineSubtitle',
  'discoverView',
  'errorsView',
  'dashboardView',
  'dashboardTenant',
  'dashboardProduct',
  'dashboardRange',
  'dashboardEnvironment',
  'dashboardTagKey',
  'dashboardTagValue',
  'dashboardRefresh',
  'dashboardError',
  'panelManagerView',
  'customPanelsPanel',
  'customPanelForm',
  'customPanelId',
  'customPanelTitle',
  'customPanelType',
  'customPanelHeight',
  'customPanelEnabled',
  'customPanelSql',
  'customPanelTest',
  'customPanelPreview',
  'customPanelPreviewPanel',
  'customPanelPreviewTitle',
  'customPanelPreviewId',
  'customPanelPreviewFrame',
  'customPanelTestResult',
  'customPanelReset',
  'customPanelError',
  'customPanelsBody',
  'customPanelsEmpty',
  'dashboardPanels',
  'dashboardEmpty',
  'systemView',
  'usersView',
  'settingsView',
  'eventsBody',
  'eventsEmpty',
  'errorsBody',
  'errorsEmpty',
  'systemBody',
  'usersBody',
  'usersEmpty',
  'settingsBody',
  'settingsEmpty',
  'createTenantForm',
  'newTenantId',
  'newTenantName',
  'createProductForm',
  'newProductTenant',
  'newProductId',
  'newProductName',
  'settingsError',
  'createUserForm',
  'newUsername',
  'newUserEmail',
  'newUserDisplayName',
  'newUserPassword',
  'newUserRole',
  'usersError',
  'drawerBackdrop',
  'drawer',
  'drawerTitle',
  'drawerSubtitle',
  'drawerBody',
  'closeDrawer',
  'textDialogBackdrop',
  'textDialog',
  'textDialogTitle',
  'textDialogSubtitle',
  'textDialogSearch',
  'textDialogPrev',
  'textDialogNext',
  'textDialogMatchCount',
  'textDialogContent',
  'closeTextDialog',
];

const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const roleLabels = {
  admin: '管理员',
  operator: '运维人员',
  viewer: '只读用户',
};

const levelLabels = {
  trace: '跟踪',
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
  fatal: '严重',
};

const DEFAULT_CUSTOM_PANEL_SQL = `SELECT
  $__timeInterval(interval_start) AS time,
  tag_value AS metric,
  sum(events) AS value
FROM grafana_tag_metrics_1m
WHERE tenant_id = '\${tenant_id}'
  AND product = '\${product}'
  AND tag_key = '\${tag_key}'
  AND ('\${tag_value}' = '' OR tag_value = '\${tag_value}')
  AND $__timeFilter(interval_start)
GROUP BY time, metric
ORDER BY time`;

const DASHBOARD_TIME_RANGES = [
  { label: '最近 1 小时', from: 'now-1h' },
  { label: '最近 6 小时', from: 'now-6h' },
  { label: '最近 24 小时', from: 'now-24h' },
  { label: '最近 7 天', from: 'now-7d' },
];

const viewMeta = {
  discover: {
    title: '日志检索',
    description: '检索日志事件并查看堆栈详情。',
    queryButton: '查询',
    showQueryTools: true,
    showMetrics: true,
    showTimeline: true,
  },
  errors: {
    title: '错误分组',
    description: '按稳定错误哈希聚合重复故障，并下钻查看相关事件。',
    queryButton: '刷新分组',
    showQueryTools: true,
    showMetrics: true,
    showTimeline: false,
  },
  dashboard: {
    title: 'Dashboard',
    description: 'Grafana panels for selected tenant/product.',
    queryButton: '刷新',
    showQueryTools: false,
    showRunButton: true,
    showMetrics: false,
    showTimeline: false,
  },
  panelManager: {
    title: 'Panel 管理',
    description: '配置受控 ClickHouse QL，并发布为 Grafana panel。',
    queryButton: '',
    showQueryTools: false,
    showRunButton: false,
    showMetrics: false,
    showTimeline: false,
  },
  users: {
    title: '用户管理',
    description: '管理用户名、角色、密码和账号状态。',
    queryButton: '',
    showQueryTools: false,
    showMetrics: false,
    showTimeline: false,
  },
  settings: {
    title: '配置管理',
    description: '维护租户、产品与 API Key。',
    queryButton: '',
    showQueryTools: false,
    showMetrics: false,
    showTimeline: false,
  },
  system: {
    title: '系统状态',
    description: '检查存储、会话、认证和队列基础状态。',
    queryButton: '',
    showQueryTools: false,
    showMetrics: false,
    showTimeline: false,
  },
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setDefaultTimeRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  el.startTime.value = toLocalInput(start);
  el.endTime.value = toLocalInput(end);
}

function localInputToIso(value) {
  return new Date(value).toISOString();
}

function formatTime(value) {
  if (!value) return '';
  const text = String(value);
  const date = new Date(text.includes('T') ? text : `${text}Z`.replace(' ', 'T'));
  if (!Number.isFinite(date.getTime())) return text;
  return date.toLocaleString();
}

function shortHash(value) {
  if (!value) return '';
  const text = String(value);
  return text.length <= 28 ? text : `${text.slice(0, 18)}...${text.slice(-8)}`;
}

function roleLabel(role) {
  return roleLabels[role] || role || '未知';
}

function levelLabel(level) {
  return levelLabels[level] || level || '';
}

function showError(message) {
  el.errorBanner.textContent = message || '';
  el.errorBanner.classList.toggle('hidden', !message);
}

function showUsersError(message) {
  el.usersError.textContent = message || '';
  el.usersError.classList.toggle('hidden', !message);
}

function showSettingsError(message) {
  el.settingsError.textContent = message || '';
  el.settingsError.classList.toggle('hidden', !message);
}

function showDashboardError(message) {
  el.dashboardError.textContent = message || '';
  el.dashboardError.classList.toggle('hidden', !message);
}

function showCustomPanelError(message, tone = 'error') {
  el.customPanelError.textContent = message || '';
  el.customPanelError.classList.toggle('hidden', !message);
  el.customPanelError.classList.toggle('is-ok', Boolean(message) && tone === 'ok');
  el.customPanelError.classList.toggle('is-error', Boolean(message) && tone !== 'ok');
}

function showCustomPanelTestResult(html, stateName = '') {
  el.customPanelTestResult.innerHTML = html || '';
  el.customPanelTestResult.classList.toggle('hidden', !html);
  el.customPanelTestResult.classList.toggle('is-ok', stateName === 'ok');
  el.customPanelTestResult.classList.toggle('is-error', stateName === 'error');
}

function showCustomPanelPreview(panel) {
  const iframeUrl = typeof panel?.iframe_url === 'string' && panel.iframe_url.startsWith('/grafana/') ? panel.iframe_url : '';
  el.customPanelPreviewPanel.classList.toggle('hidden', !iframeUrl);
  el.customPanelPreviewPanel.classList.remove('has-error');
  if (!iframeUrl) {
    el.customPanelPreviewFrame.removeAttribute('src');
    return;
  }
  el.customPanelPreviewTitle.textContent = panel.title || '预览面板';
  el.customPanelPreviewId.textContent = panel.id || '';
  el.customPanelPreviewFrame.style.height = `${Math.max(220, Math.min(Number(panel.height) || 320, 640))}px`;
  el.customPanelPreviewFrame.src = iframeUrl;
}

function hasPermission(permission) {
  return Boolean(state.user?.permissions?.includes(permission));
}

function canManageDashboards() {
  return hasPermission('dashboards:write');
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders(options.headers || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || response.statusText || '请求失败');
  }
  return data;
}

async function login(loginName, password) {
  const response = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  state.token = response.data.accessToken;
  state.user = response.data.user;
  localStorage.setItem(TOKEN_KEY, state.token);
  renderAuth();
  await loadSettings();
  await loadSystem();
  if (state.activeView === 'dashboard') {
    await loadGrafanaEmbedConfig();
  } else {
    await runQuery();
  }
}

async function loadMe() {
  if (!state.token) {
    renderAuth();
    return;
  }

  try {
    const response = await api('/api/auth/me');
    state.user = response.data;
    renderAuth();
    await loadSettings();
    await loadSystem();
    if (state.activeView === 'dashboard') {
      await loadGrafanaEmbedConfig();
    } else {
      await runQuery();
    }
  } catch {
    state.token = '';
    state.user = null;
    localStorage.removeItem(TOKEN_KEY);
    renderAuth();
  }
}

function renderAuth() {
  const authenticated = Boolean(state.token && state.user);
  el.loginView.classList.toggle('hidden', authenticated);
  el.appView.classList.toggle('hidden', !authenticated);
  if (authenticated) {
    el.currentUser.textContent = `${state.user.username || state.user.email} · ${roleLabel(state.user.role)}`;
  }
  el.panelManagerOpen.classList.toggle('hidden', !(authenticated && state.activeView === 'dashboard' && canManageDashboards()));
  const usersButton = document.querySelector('[data-view="users"]');
  usersButton?.classList.toggle('hidden', !hasPermission('users:manage'));
  const settingsButton = document.querySelector('[data-view="settings"]');
  settingsButton?.classList.toggle('hidden', !hasPermission('settings:write'));
  const dashboardButton = document.querySelector('[data-view="dashboard"]');
  dashboardButton?.classList.toggle('hidden', !hasPermission('logs:read'));
  if (state.activeView === 'users' && !hasPermission('users:manage')) setView('discover');
  if (state.activeView === 'settings' && !hasPermission('settings:write')) setView('discover');
  if (state.activeView === 'dashboard' && !hasPermission('logs:read')) setView('discover');
  if (state.activeView === 'panelManager' && !canManageDashboards()) setView('dashboard');
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Local token cleanup is still correct if the server session has already expired.
  }
  state.token = '';
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  renderAuth();
}

function queryParams(forErrors, options = {}) {
  const params = new URLSearchParams();
  params.set('tenant_id', el.tenant.value || 'sudo');
  params.set('start_time', localInputToIso(el.startTime.value));
  params.set('end_time', localInputToIso(el.endTime.value));
  params.set('limit', forErrors ? '200' : el.limit.value);
  if (options.errorHash) params.set('error_hash', options.errorHash);

  const mappings = [
    ['product', 'product'],
    ['level', 'level'],
    ['topic', 'topic'],
    ['environment', 'environment'],
    ['component', 'component'],
    ['version', 'version'],
    ['userId', 'user_identifier'],
    ['sessionId', 'session_id'],
    ['traceId', 'trace_id'],
  ];

  for (const [elementId, queryName] of mappings) {
    const value = el[elementId].value.trim();
    if (value) params.set(queryName, value);
  }

  const tags = el.tagSearch.value
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const tag of tags) {
    params.append('tag', tag);
  }
  if (tags.length > 0) params.set('tag_mode', el.tagMode.value || 'all');

  return params;
}

async function runQuery(options = {}) {
  if (!state.token) return;
  showError('');
  el.runQuery.disabled = true;
  try {
    const rows = await api(`/v1/logs/search?${queryParams(false, options).toString()}`);
    const groups = await api(`/v1/logs/errors/summary?${queryParams(true, options).toString()}`);
    state.rows = rows.data || [];
    state.errorGroups = groups.data || [];
    renderAll();
  } catch (error) {
    showError(error instanceof Error ? error.message : '查询失败');
  } finally {
    el.runQuery.disabled = false;
  }
}

async function loadSystem() {
  if (!state.token) return;
  try {
    const response = await api('/api/system/health');
    el.systemBody.innerHTML = [
      ['ClickHouse', response.data.clickhouse ? '健康' : '不可用'],
      ['PostgreSQL 配置库', response.data.postgres ? '健康' : '不可用'],
      ['Redis 会话', response.data.redis ? '健康' : '不可用'],
      ['队列基础', response.data.queue ? '就绪' : '不可用'],
      ['当前用户', state.user?.username || '未知'],
      ['角色', roleLabel(state.user?.role)],
    ]
      .map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`)
      .join('');
  } catch (error) {
    el.systemBody.innerHTML = `<article><span>系统</span><strong>${escapeHtml(error instanceof Error ? error.message : '不可用')}</strong></article>`;
  }
}

async function loadSettings() {
  if (!state.token) return;
  showSettingsError('');
  try {
    const response = await api('/api/settings/tenants');
    state.tenants = response.data || [];
    renderTenantProductFilters();
    renderSettings();
    if (state.activeView === 'dashboard') await loadGrafanaEmbedConfig();
  } catch (error) {
    showSettingsError(error instanceof Error ? error.message : '加载配置失败');
  }
}

function enabledTenants() {
  return state.tenants.filter((tenant) => tenant.enabled);
}

function enabledProducts(tenantId) {
  return state.tenants.find((tenant) => tenant.tenantId === tenantId)?.products.filter((product) => product.enabled) || [];
}

function renderTenantProductFilters() {
  const previousTenant = el.tenant.value;
  const tenants = enabledTenants();
  el.tenant.innerHTML = tenants
    .map((tenant) => `<option value="${escapeHtml(tenant.tenantId)}">${escapeHtml(tenant.name || tenant.tenantId)}</option>`)
    .join('');
  if (tenants.some((tenant) => tenant.tenantId === previousTenant)) {
    el.tenant.value = previousTenant;
  } else if (tenants[0]) {
    el.tenant.value = tenants[0].tenantId;
  }
  renderProductFilter();
  renderDashboardTenantProductFilters();
  renderProductTenantOptions();
}

function renderProductFilter() {
  const previousProduct = el.product.value;
  const products = enabledProducts(el.tenant.value);
  el.product.innerHTML = products
    .map((product) => `<option value="${escapeHtml(product.product)}">${escapeHtml(product.name || product.product)}</option>`)
    .join('');
  if (products.some((product) => product.product === previousProduct)) {
    el.product.value = previousProduct;
  } else if (products[0]) {
    el.product.value = products[0].product;
  }
}

function renderDashboardTenantProductFilters() {
  const previousTenant = el.dashboardTenant.value || el.tenant.value;
  const tenants = enabledTenants();
  el.dashboardTenant.innerHTML = tenants
    .map((tenant) => `<option value="${escapeHtml(tenant.tenantId)}">${escapeHtml(tenant.name || tenant.tenantId)}</option>`)
    .join('');
  if (tenants.some((tenant) => tenant.tenantId === previousTenant)) {
    el.dashboardTenant.value = previousTenant;
  } else if (tenants[0]) {
    el.dashboardTenant.value = tenants[0].tenantId;
  }
  renderDashboardProductFilter();
}

function renderDashboardProductFilter() {
  const previousProduct = el.dashboardProduct.value || el.product.value;
  const products = enabledProducts(el.dashboardTenant.value);
  el.dashboardProduct.innerHTML = products
    .map((product) => `<option value="${escapeHtml(product.product)}">${escapeHtml(product.name || product.product)}</option>`)
    .join('');
  if (products.some((product) => product.product === previousProduct)) {
    el.dashboardProduct.value = previousProduct;
  } else if (products[0]) {
    el.dashboardProduct.value = products[0].product;
  }
}

function renderProductTenantOptions() {
  el.newProductTenant.innerHTML = state.tenants
    .map((tenant) => `<option value="${escapeHtml(tenant.tenantId)}">${escapeHtml(tenant.name || tenant.tenantId)}</option>`)
    .join('');
}

function dashboardSelection() {
  const tenantId = el.dashboardTenant.value;
  const product = el.dashboardProduct.value;
  if (!tenantId || !product) return null;
  return { tenantId, product };
}

function setSelectOptions(select, options, selectedValue, emptyLabel = '') {
  const values = [...new Set(options.filter((value) => value !== null && value !== undefined).map((value) => String(value)))];
  select.innerHTML = [
    ...(emptyLabel ? [`<option value="">${escapeHtml(emptyLabel)}</option>`] : []),
    ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`),
  ].join('');
  if (values.includes(String(selectedValue))) {
    select.value = String(selectedValue);
  } else if (emptyLabel && !selectedValue) {
    select.value = '';
  } else if (values.length > 0) {
    select.value = values[0];
  }
}

function setDashboardRangeOptions(ranges, selectedValue = 'now-6h') {
  const items = ranges?.length ? ranges : DASHBOARD_TIME_RANGES;
  el.dashboardRange.innerHTML = items
    .map((range) => `<option value="${escapeHtml(range.from)}">${escapeHtml(range.label || range.from)}</option>`)
    .join('');
  el.dashboardRange.value = items.some((range) => range.from === selectedValue) ? selectedValue : items[0]?.from || 'now-6h';
}

function dashboardConfigParams() {
  const selection = dashboardSelection();
  if (!selection) return null;
  const params = new URLSearchParams({
    tenant_id: selection.tenantId,
    product: selection.product,
  });
  params.set('from', el.dashboardRange.value || 'now-6h');
  if (el.dashboardEnvironment.value.trim()) params.set('environment', el.dashboardEnvironment.value.trim());
  if (el.dashboardTagKey.value.trim()) params.set('tag_key', el.dashboardTagKey.value.trim());
  params.set('tag_value', el.dashboardTagValue.value.trim());
  return params;
}

async function loadGrafanaEmbedConfig() {
  if (!state.token || !['dashboard', 'panelManager'].includes(state.activeView)) return;
  const params = dashboardConfigParams();
  showDashboardError('');
  el.customPanelsPanel.classList.toggle('hidden', !(canManageDashboards() && state.activeView === 'panelManager'));
  if (!params) {
    state.grafana.config = null;
    el.dashboardPanels.innerHTML = '';
    el.dashboardEmpty.textContent = '暂无启用的租户或产品。';
    el.dashboardEmpty.classList.remove('hidden');
    return;
  }

  state.grafana.loading = true;
  el.dashboardRefresh.disabled = true;
  el.runQuery.disabled = true;
  try {
    const response = await api(`/api/grafana/embed-config?${params.toString()}`);
    state.grafana.config = response.data || null;
    renderDashboardConfig(state.grafana.config);
    await loadCustomPanels();
  } catch (error) {
    state.grafana.config = null;
    el.dashboardPanels.innerHTML = '';
    el.dashboardEmpty.classList.add('hidden');
    showDashboardError(error instanceof Error ? error.message : '加载 Dashboard 失败');
  } finally {
    state.grafana.loading = false;
    el.dashboardRefresh.disabled = false;
    el.runQuery.disabled = false;
  }
}

async function loadCustomPanels() {
  if (!canManageDashboards() || state.activeView !== 'panelManager') {
    state.grafana.customPanels = [];
    renderCustomPanels();
    return;
  }
  const params = dashboardConfigParams();
  if (!params) return;
  try {
    const response = await api(`/api/grafana/custom-panels?${params.toString()}`);
    state.grafana.customPanels = response.data || [];
    renderCustomPanels();
  } catch (error) {
    showCustomPanelError(error instanceof Error ? error.message : '加载自定义面板失败');
  }
}

function renderDashboardConfig(config) {
  if (!config?.enabled) {
    el.dashboardPanels.innerHTML = '';
    el.dashboardEmpty.textContent = 'Dashboard 未启用。';
    el.dashboardEmpty.classList.remove('hidden');
    return;
  }

  const selected = config.selected || {};
  setDashboardRangeOptions(config.time_ranges || DASHBOARD_TIME_RANGES, selected.from || el.dashboardRange.value || 'now-6h');
  el.dashboardEnvironment.value = selected.environment || '';
  el.dashboardTagKey.value = selected.tag_key || el.dashboardTagKey.value || '';
  el.dashboardTagValue.value = selected.tag_value || '';
  renderDashboardPanels(config.panels || []);
}

function renderDashboardPanels(panels) {
  el.dashboardPanels.innerHTML = '';
  el.dashboardEmpty.textContent = '暂无可展示的 panels。';
  el.dashboardEmpty.classList.toggle('hidden', panels.length > 0);

  for (const panel of panels) {
    const iframeUrl = typeof panel.iframe_url === 'string' && panel.iframe_url.startsWith('/grafana/') ? panel.iframe_url : '';
    if (!iframeUrl) continue;
    const article = document.createElement('article');
    article.className = 'dashboard-panel';
    article.innerHTML = `<header>
      <h2>${escapeHtml(panel.title || panel.id || 'Panel')}</h2>
      <span class="mono">${escapeHtml(panel.id || '')}</span>
    </header>
    <iframe
      title="${escapeHtml(panel.title || panel.id || 'Grafana panel')}"
      src="${escapeHtml(iframeUrl)}"
      data-src="${escapeHtml(iframeUrl)}"
      style="height: ${Math.max(220, Math.min(Number(panel.height) || 260, 640))}px"
      loading="lazy"
      referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    ></iframe>
    <div class="dashboard-panel-error">Panel 加载失败。</div>`;
    article.querySelector('iframe')?.addEventListener('error', () => article.classList.add('has-error'));
    el.dashboardPanels.appendChild(article);
  }
}

function refreshDashboardPanels() {
  if (state.activeView !== 'dashboard') return;
  const frames = [...el.dashboardPanels.querySelectorAll('iframe[data-src]')];
  if (!frames.length) {
    loadGrafanaEmbedConfig();
    return;
  }
  const refreshToken = String(Date.now());
  for (const frame of frames) {
    const url = new URL(frame.dataset.src || frame.getAttribute('src'), window.location.origin);
    url.searchParams.set('_refresh', refreshToken);
    frame.src = `${url.pathname}${url.search}`;
  }
}

function resetCustomPanelForm() {
  el.customPanelId.value = '';
  el.customPanelForm.reset();
  el.customPanelType.value = 'timeseries';
  el.customPanelHeight.value = '320';
  el.customPanelEnabled.checked = true;
  el.customPanelSql.value = DEFAULT_CUSTOM_PANEL_SQL;
  showCustomPanelError('');
  showCustomPanelTestResult('');
  showCustomPanelPreview(null);
}

function customPanelPayload() {
  const selection = dashboardSelection();
  if (!selection) throw new Error('请先选择租户和产品');
  return {
    tenant_id: selection.tenantId,
    product: selection.product,
    title: el.customPanelTitle.value.trim(),
    panel_type: el.customPanelType.value,
    height: Number(el.customPanelHeight.value || 320),
    enabled: el.customPanelEnabled.checked,
    query_sql: el.customPanelSql.value.trim(),
    from: el.dashboardRange.value || 'now-6h',
    to: 'now',
    environment: el.dashboardEnvironment.value.trim() || 'production',
    tag_key: el.dashboardTagKey.value.trim(),
    tag_value: el.dashboardTagValue.value.trim(),
  };
}

function customPanelSampleTable(rows) {
  if (!rows?.length) return '<div class="muted">查询可执行，但当前条件没有返回样例数据。</div>';
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))].slice(0, 8);
  const body = rows
    .slice(0, 5)
    .map(
      (row) =>
        `<tr>${columns
          .map((column) => {
            const value = row?.[column];
            const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
            return `<td title="${escapeHtml(text)}">${escapeHtml(text)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return `<table>
    <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

async function testCustomPanel() {
  showCustomPanelError('');
  showCustomPanelTestResult('');
  el.customPanelTest.disabled = true;
  try {
    const response = await api('/api/grafana/custom-panels/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customPanelPayload()),
    });
    const data = response.data || {};
    const tables = (data.tables || []).join(', ') || '-';
    showCustomPanelTestResult(
      `<div>QL 测试通过，返回 ${Number(data.row_count || 0)} 行样例，耗时 ${Number(data.elapsed_ms || 0)} ms。</div>
      <div class="mono">tables: ${escapeHtml(tables)}</div>
      ${customPanelSampleTable(data.rows || [])}`,
      'ok',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'QL 测试失败';
    showCustomPanelTestResult(`<div>${escapeHtml(message)}</div>`, 'error');
  } finally {
    el.customPanelTest.disabled = false;
  }
}

async function previewCustomPanel() {
  showCustomPanelError('');
  showCustomPanelTestResult('');
  showCustomPanelPreview(null);
  el.customPanelPreview.disabled = true;
  try {
    const response = await api('/api/grafana/custom-panels/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customPanelPayload()),
    });
    showCustomPanelPreview(response.data || {});
  } catch (error) {
    showCustomPanelError(error instanceof Error ? error.message : '预览自定义面板失败');
  } finally {
    el.customPanelPreview.disabled = false;
  }
}

async function saveCustomPanel() {
  showCustomPanelError('');
  try {
    const id = el.customPanelId.value;
    const response = await api(id ? `/api/grafana/custom-panels/${encodeURIComponent(id)}` : '/api/grafana/custom-panels', {
      method: id ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customPanelPayload()),
    });
    const panel = response.data || {};
    resetCustomPanelForm();
    await loadGrafanaEmbedConfig();
    if (panel.publishError) {
      showCustomPanelError(`保存成功，发布失败：${panel.publishError}`);
    } else if (panel.publishedAt) {
      showCustomPanelError('保存并发布成功。', 'ok');
    } else {
      showCustomPanelError('保存成功，当前未发布。');
    }
  } catch (error) {
    showCustomPanelError(error instanceof Error ? error.message : '保存自定义面板失败');
  }
}

function editCustomPanel(id) {
  const panel = state.grafana.customPanels.find((item) => item.id === id);
  if (!panel) return;
  el.customPanelId.value = panel.id;
  el.customPanelTitle.value = panel.title || '';
  el.customPanelType.value = panel.panelType || 'timeseries';
  el.customPanelHeight.value = String(panel.height || 320);
  el.customPanelEnabled.checked = Boolean(panel.enabled);
  el.customPanelSql.value = panel.querySql || DEFAULT_CUSTOM_PANEL_SQL;
  showCustomPanelError('');
  showCustomPanelTestResult('');
  showCustomPanelPreview(null);
  el.customPanelTitle.focus({ preventScroll: true });
}

async function publishCustomPanel(id) {
  showCustomPanelError('');
  try {
    const response = await api(`/api/grafana/custom-panels/${encodeURIComponent(id)}/publish`, { method: 'POST' });
    const panel = response.data || {};
    await loadGrafanaEmbedConfig();
    if (panel.publishError) {
      showCustomPanelError(`发布失败：${panel.publishError}`);
    } else if (panel.publishedAt) {
      showCustomPanelError('发布成功。', 'ok');
    } else {
      showCustomPanelError('发布未完成：Grafana 未启用或发布通道关闭。');
    }
  } catch (error) {
    showCustomPanelError(error instanceof Error ? error.message : '发布自定义面板失败');
  }
}

async function deleteCustomPanel(id) {
  const panel = state.grafana.customPanels.find((item) => item.id === id);
  if (!window.confirm(`确认删除自定义面板 ${panel?.title || id}？`)) return;
  showCustomPanelError('');
  try {
    await api(`/api/grafana/custom-panels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (el.customPanelId.value === id) resetCustomPanelForm();
    await loadGrafanaEmbedConfig();
  } catch (error) {
    showCustomPanelError(error instanceof Error ? error.message : '删除自定义面板失败');
  }
}

function renderCustomPanels() {
  el.customPanelsBody.innerHTML = '';
  el.customPanelsEmpty.classList.toggle('hidden', state.grafana.customPanels.length > 0);
  for (const panel of state.grafana.customPanels) {
    const tr = document.createElement('tr');
    const publishState = panel.publishError
      ? `<span class="publish-error" title="${escapeHtml(panel.publishError)}">发布失败</span>`
      : panel.publishedAt
        ? '已发布'
        : '未发布';
    const retryButton =
      panel.enabled && (!panel.publishedAt || panel.publishError)
        ? `<button class="secondary small" data-action="publish-custom-panel" data-panel-id="${escapeHtml(panel.id)}">重试发布</button>`
        : '';
    tr.innerHTML =
      `<td>${escapeHtml(panel.title || '')}</td>` +
      `<td>${escapeHtml(panel.panelType || '')}</td>` +
      `<td>${panel.enabled ? publishState : '已停用'}</td>` +
      `<td class="mono">${escapeHtml(formatTime(panel.publishedAt))}</td>` +
      `<td><div class="row-actions">
        <button class="secondary small" data-action="edit-custom-panel" data-panel-id="${escapeHtml(panel.id)}">编辑</button>
        ${retryButton}
        <button class="danger small" data-action="delete-custom-panel" data-panel-id="${escapeHtml(panel.id)}">删除</button>
      </div></td>`;
    el.customPanelsBody.appendChild(tr);
  }
}

function productList(products, tenantId) {
  if (!products?.length) return '<div class="product-empty">暂无产品</div>';
  return products
    .map(
      (product) => {
        const isDefaultProduct = tenantId === DEFAULT_TENANT_ID && product.product === DEFAULT_PRODUCT_ID;
        const actions = isDefaultProduct
          ? ''
          : `<button class="secondary small" data-action="save-product" data-tenant-id="${escapeHtml(product.tenantId)}" data-product="${escapeHtml(product.product)}">保存产品</button>
          <button class="danger small" data-action="delete-product" data-tenant-id="${escapeHtml(product.tenantId)}" data-product="${escapeHtml(product.product)}">删除产品</button>`;
        return `<div class="config-product" data-tenant-id="${escapeHtml(product.tenantId)}" data-product="${escapeHtml(product.product)}">
          <span class="mono">${escapeHtml(product.product)}</span>
          <input data-product-field="name" value="${escapeHtml(product.name)}"${isDefaultProduct ? ' disabled' : ''} />
          ${actions}
        </div>`;
      },
    )
    .join('') || `<div class="product-empty">租户 ${escapeHtml(tenantId)} 暂无产品</div>`;
}

function renderSettings() {
  el.settingsBody.innerHTML = '';
  el.settingsEmpty.classList.toggle('hidden', state.tenants.length > 0);

  for (const tenant of state.tenants) {
    const productCount = tenant.products?.length || 0;
    const expanded = state.expandedTenants.has(tenant.tenantId);
    const isDefaultTenant = tenant.tenantId === DEFAULT_TENANT_ID;
    const tr = document.createElement('tr');
    tr.className = 'tenant-row';
    tr.dataset.tenantId = tenant.tenantId;
    tr.innerHTML =
      `<td class="mono">${escapeHtml(tenant.tenantId)}</td>` +
      `<td><input data-tenant-field="name" value="${escapeHtml(tenant.name)}"${isDefaultTenant ? ' disabled' : ''} /></td>` +
      `<td><div class="api-key-cell">
        <span class="mono api-key-value" title="${escapeHtml(tenant.apiKey || '')}">${escapeHtml(tenant.apiKey || '')}</span>
        <button class="secondary small" data-action="copy-api-key" data-api-key="${escapeHtml(tenant.apiKey || '')}" data-tenant-id="${escapeHtml(tenant.tenantId)}">复制</button>
      </div></td>` +
      `<td><div class="row-actions">
        <button class="secondary small" data-action="toggle-products" data-tenant-id="${escapeHtml(tenant.tenantId)}">${expanded ? '收起产品' : `展开产品 (${productCount})`}</button>
        ${
          isDefaultTenant
            ? ''
            : `<button class="secondary small" data-action="save-tenant" data-tenant-id="${escapeHtml(tenant.tenantId)}">保存租户</button>
        <button class="danger small" data-action="delete-tenant" data-tenant-id="${escapeHtml(tenant.tenantId)}">删除租户</button>`
        }
      </div></td>`;
    el.settingsBody.appendChild(tr);

    if (expanded) {
      const productTr = document.createElement('tr');
      productTr.className = 'tenant-products-row';
      productTr.dataset.tenantId = tenant.tenantId;
      productTr.innerHTML = `<td colspan="4">
        <div class="tenant-products-panel">
          <div class="tenant-products-title">产品列表</div>
          ${productList(tenant.products, tenant.tenantId)}
        </div>
      </td>`;
      el.settingsBody.appendChild(productTr);
    }
  }
}

function toggleTenantProducts(tenantId) {
  if (state.expandedTenants.has(tenantId)) {
    state.expandedTenants.delete(tenantId);
  } else {
    state.expandedTenants.add(tenantId);
  }
  renderSettings();
}

function tenantPayloadFromRow(tenantId) {
  const row = el.settingsBody.querySelector(`tr[data-tenant-id="${CSS.escape(tenantId)}"]`);
  if (!row) throw new Error('未找到租户行');
  return {
    name: row.querySelector('[data-tenant-field="name"]').value.trim(),
  };
}

async function copyApiKey(apiKey) {
  if (!apiKey) return;
  try {
    await navigator.clipboard.writeText(apiKey);
    showSettingsError('API Key 已复制。');
  } catch {
    showSettingsError('复制失败，请手动选择 API Key。');
  }
}

function productPayloadFromRow(tenantId, product) {
  const row = el.settingsBody.querySelector(
    `.config-product[data-tenant-id="${CSS.escape(tenantId)}"][data-product="${CSS.escape(product)}"]`,
  );
  if (!row) throw new Error('未找到产品行');
  return {
    name: row.querySelector('[data-product-field="name"]').value.trim(),
  };
}

async function createTenant() {
  showSettingsError('');
  const payload = {
    tenantId: el.newTenantId.value.trim(),
    name: el.newTenantName.value.trim(),
    enabled: true,
  };
  try {
    await api('/api/settings/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    el.createTenantForm.reset();
    await loadSettings();
  } catch (error) {
    showSettingsError(error instanceof Error ? error.message : '创建租户失败');
  }
}

async function updateTenant(tenantId) {
  showSettingsError('');
  try {
    await api(`/api/settings/tenants/${encodeURIComponent(tenantId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tenantPayloadFromRow(tenantId)),
    });
    await loadSettings();
  } catch (error) {
    showSettingsError(error instanceof Error ? error.message : '保存租户失败');
  }
}

async function deleteTenant(tenantId) {
  if (!window.confirm(`确认删除租户 ${tenantId}？该租户下产品配置也会删除。`)) return;
  showSettingsError('');
  try {
    await api(`/api/settings/tenants/${encodeURIComponent(tenantId)}`, { method: 'DELETE' });
    await loadSettings();
  } catch (error) {
    showSettingsError(error instanceof Error ? error.message : '删除租户失败');
  }
}

async function createProduct() {
  showSettingsError('');
  const tenantId = el.newProductTenant.value;
  const payload = {
    product: el.newProductId.value.trim(),
    name: el.newProductName.value.trim(),
    enabled: true,
  };
  try {
    await api(`/api/settings/tenants/${encodeURIComponent(tenantId)}/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    el.createProductForm.reset();
    await loadSettings();
  } catch (error) {
    showSettingsError(error instanceof Error ? error.message : '创建产品失败');
  }
}

async function updateProduct(tenantId, product) {
  showSettingsError('');
  try {
    await api(`/api/settings/tenants/${encodeURIComponent(tenantId)}/products/${encodeURIComponent(product)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(productPayloadFromRow(tenantId, product)),
    });
    await loadSettings();
  } catch (error) {
    showSettingsError(error instanceof Error ? error.message : '保存产品失败');
  }
}

async function deleteProduct(tenantId, product) {
  if (!window.confirm(`确认删除产品 ${tenantId}/${product}？`)) return;
  showSettingsError('');
  try {
    await api(`/api/settings/tenants/${encodeURIComponent(tenantId)}/products/${encodeURIComponent(product)}`, {
      method: 'DELETE',
    });
    await loadSettings();
  } catch (error) {
    showSettingsError(error instanceof Error ? error.message : '删除产品失败');
  }
}

async function loadUsers() {
  if (!state.token || !hasPermission('users:manage')) return;
  showUsersError('');
  try {
    const response = await api('/api/users');
    state.users = response.data || [];
    renderUsers();
  } catch (error) {
    showUsersError(error instanceof Error ? error.message : '加载用户失败');
  }
}

function roleOptions(selectedRole) {
  return ['viewer', 'operator', 'admin']
    .map((role) => `<option value="${role}"${role === selectedRole ? ' selected' : ''}>${roleLabel(role)}</option>`)
    .join('');
}

function renderUsers() {
  el.usersBody.innerHTML = '';
  el.usersEmpty.classList.toggle('hidden', state.users.length > 0);

  for (const user of state.users) {
    const isSelf = user.id === state.user?.id;
    const tr = document.createElement('tr');
    tr.dataset.userId = user.id;
    tr.innerHTML =
      `<td><input data-field="username" value="${escapeHtml(user.username)}" /></td>` +
      `<td><input data-field="email" value="${escapeHtml(user.email)}" /></td>` +
      `<td><input data-field="displayName" value="${escapeHtml(user.displayName)}" /></td>` +
      `<td><select data-field="role"${isSelf ? ' disabled' : ''}>${roleOptions(user.role)}</select></td>` +
      `<td><label class="switch-row"><input data-field="enabled" type="checkbox"${user.enabled ? ' checked' : ''}${isSelf ? ' disabled' : ''} />启用</label></td>` +
      `<td class="mono">${escapeHtml(formatTime(user.lastLoginAt))}</td>` +
      `<td><div class="row-actions">
        <button class="secondary small" data-action="save" data-user-id="${escapeHtml(user.id)}">保存</button>
        <button class="secondary small" data-action="password" data-user-id="${escapeHtml(user.id)}">重置密码</button>
        <button class="danger small" data-action="delete" data-user-id="${escapeHtml(user.id)}"${isSelf ? ' disabled' : ''}>删除</button>
      </div></td>`;
    el.usersBody.appendChild(tr);
  }
}

function userPayloadFromRow(userId) {
  const row = el.usersBody.querySelector(`tr[data-user-id="${CSS.escape(userId)}"]`);
  if (!row) throw new Error('未找到用户行');
  return {
    username: row.querySelector('[data-field="username"]').value.trim(),
    email: row.querySelector('[data-field="email"]').value.trim(),
    displayName: row.querySelector('[data-field="displayName"]').value.trim(),
    role: row.querySelector('[data-field="role"]').value,
    enabled: row.querySelector('[data-field="enabled"]').checked,
  };
}

async function createUser() {
  showUsersError('');
  const payload = {
    username: el.newUsername.value.trim(),
    email: el.newUserEmail.value.trim(),
    displayName: el.newUserDisplayName.value.trim(),
    password: el.newUserPassword.value,
    role: el.newUserRole.value,
    enabled: true,
  };
  try {
    await api('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    el.createUserForm.reset();
    el.newUserRole.value = 'viewer';
    await loadUsers();
  } catch (error) {
    showUsersError(error instanceof Error ? error.message : '创建用户失败');
  }
}

async function updateUser(userId) {
  showUsersError('');
  try {
    await api(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(userPayloadFromRow(userId)),
    });
    await loadUsers();
    if (userId === state.user?.id) await loadMe();
  } catch (error) {
    showUsersError(error instanceof Error ? error.message : '更新用户失败');
  }
}

async function resetUserPassword(userId) {
  const password = window.prompt('新密码');
  if (!password) return;
  showUsersError('');
  try {
    await api(`/api/users/${encodeURIComponent(userId)}/password`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    await loadUsers();
  } catch (error) {
    showUsersError(error instanceof Error ? error.message : '重置密码失败');
  }
}

async function deleteUser(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!window.confirm(`确认删除用户 ${user?.username || userId}？`)) return;
  showUsersError('');
  try {
    await api(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    await loadUsers();
  } catch (error) {
    showUsersError(error instanceof Error ? error.message : '删除用户失败');
  }
}

function renderAll() {
  renderMetrics();
  renderTimeline();
  renderEvents();
  renderErrors();
}

function renderMetrics() {
  const errorRows = state.rows.filter((row) => row.level === 'error' || row.level === 'fatal');
  const users = new Set(state.rows.map((row) => row.user_identifier_hash || row.user_id_hash).filter(Boolean));
  el.metricRows.textContent = String(state.rows.length);
  el.metricErrors.textContent = String(errorRows.length);
  el.metricUsers.textContent = String(users.size);
  el.metricGroups.textContent = String(state.errorGroups.length);
}

function renderTimeline() {
  el.timeline.innerHTML = '';
  if (!state.rows.length) {
    el.timelineSubtitle.textContent = '所选时间范围内没有匹配日志。';
    return;
  }

  const start = new Date(localInputToIso(el.startTime.value)).getTime();
  const end = new Date(localInputToIso(el.endTime.value)).getTime();
  const bucketCount = 32;
  const bucketSize = Math.max(1, Math.ceil((end - start) / bucketCount));
  const buckets = Array.from({ length: bucketCount }, () => ({ total: 0, errors: 0 }));

  for (const row of state.rows) {
    const time = new Date(`${String(row.timestamp).replace(' ', 'T')}Z`).getTime();
    if (!Number.isFinite(time)) continue;
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((time - start) / bucketSize)));
    buckets[index].total += 1;
    if (row.level === 'error' || row.level === 'fatal') buckets[index].errors += 1;
  }

  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  buckets.forEach((bucket, index) => {
    const bar = document.createElement('div');
    bar.className = `bar${bucket.errors ? ' error' : ''}`;
    bar.style.height = `${Math.max(4, Math.round((bucket.total / max) * 140))}px`;
    const bucketStart = new Date(start + index * bucketSize);
    bar.dataset.title = `${bucketStart.toLocaleString()} · ${bucket.total} 条日志 · ${bucket.errors} 个错误`;
    el.timeline.appendChild(bar);
  });
  el.timelineSubtitle.textContent = `所选时间范围内共 ${state.rows.length} 条事件。`;
}

function renderEvents() {
  el.eventsBody.innerHTML = '';
  el.eventsEmpty.classList.toggle('hidden', state.rows.length > 0);

  for (const row of state.rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="mono">${escapeHtml(formatTime(row.timestamp))}</td>` +
      `<td><span class="pill ${escapeHtml(row.level || '')}">${escapeHtml(row.level || '')}</span></td>` +
      `<td>${escapeHtml(row.product || '')}</td>` +
      `<td>${escapeHtml(row.component || '')}</td>` +
      `<td class="message-cell">${escapeHtml(row.message || row.error_message || '')}</td>` +
      `<td class="tags-cell">${renderTagChips(row)}</td>` +
      `<td class="mono hash-cell" title="${escapeHtml(row.user_identifier_hash || row.user_id_hash || '')}">${escapeHtml(shortHash(row.user_identifier_hash || row.user_id_hash))}</td>` +
      `<td class="mono hash-cell" title="${escapeHtml(row.error_hash || '')}">${escapeHtml(shortHash(row.error_hash))}</td>`;
    tr.addEventListener('click', () => openEvent(row));
    el.eventsBody.appendChild(tr);
  }
}

function renderErrors() {
  el.errorsBody.innerHTML = '';
  el.errorsEmpty.classList.toggle('hidden', state.errorGroups.length > 0);

  for (const group of state.errorGroups) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="mono">${escapeHtml(formatTime(group.last_seen))}</td>` +
      `<td class="mono">${escapeHtml(group.occurrences || 0)}</td>` +
      `<td class="message-cell"><strong>${escapeHtml(group.error_name || '错误')}</strong><br />${escapeHtml(group.error_message || '')}</td>` +
      `<td>${escapeHtml(group.component || '')}</td>` +
      `<td>${escapeHtml(group.version || '')}</td>` +
      `<td class="mono hash-cell" title="${escapeHtml(group.error_hash || '')}">${escapeHtml(shortHash(group.error_hash))}</td>`;
    tr.addEventListener('click', () => {
      setView('discover');
      runQuery({ errorHash: group.error_hash || '' });
    });
    el.errorsBody.appendChild(tr);
  }
}

async function openEvent(row) {
  el.drawer.classList.add('open');
  el.drawerBackdrop.classList.remove('hidden');
  el.drawer.setAttribute('aria-hidden', 'false');
  el.drawerTitle.textContent = row.level ? `${levelLabel(row.level)}事件` : '事件详情';
  el.drawerSubtitle.textContent = row.event_id || '';
  el.drawerBody.innerHTML = '<div class="empty">正在加载事件详情...</div>';
  el.drawerBody.scrollTop = 0;
  el.drawerBody.focus({ preventScroll: true });

  try {
    const tenantId = encodeURIComponent(row.tenant_id || el.tenant.value || 'sudo');
    const eventId = encodeURIComponent(row.event_id || '');
    const detailResponse = await api(`/v1/logs/events/${eventId}?tenant_id=${tenantId}`);
    const detail = detailResponse.data || row;
    let stack = '';
    if (detail.stack_ref) {
      const stackResponse = await api(`/v1/logs/blobs?ref=${encodeURIComponent(detail.stack_ref)}`);
      stack = stackResponse.data?.content || '';
    }
    renderDetail(detail, stack);
  } catch (error) {
    el.drawerBody.innerHTML = `<div class="error-banner">${escapeHtml(error instanceof Error ? error.message : '加载事件失败')}</div>`;
  }
}

function detailItem(label, value) {
  return `<div class="detail-item"><div class="detail-label">${escapeHtml(label)}</div><div class="detail-value mono">${escapeHtml(value || '')}</div></div>`;
}

function detailTextSection(key, title, content, subtitle = '') {
  const preClass = key === 'raw' ? ' class="raw-json"' : '';
  return `<section class="panel detail-section">
    <div class="panel-header detail-section-header">
      <div class="detail-section-title">
        <h2>${escapeHtml(title)}</h2>
        ${subtitle ? `<span class="mono">${escapeHtml(subtitle)}</span>` : ''}
      </div>
      <button class="secondary small detail-text-button" type="button" data-detail-text-key="${escapeHtml(key)}">
        <span>详情</span><span aria-hidden="true">🔍</span>
      </button>
    </div>
    <pre${preClass}>${escapeHtml(content)}</pre>
  </section>`;
}

function tagsFromRow(row) {
  const tags = safeJson(row.tags_json);
  if (Object.keys(tags).length > 0) return tags;

  const result = {};
  for (const item of row.tags_kv || []) {
    const text = String(item);
    const separatorIndex = text.indexOf('\x1F');
    if (separatorIndex <= 0) continue;
    result[text.slice(0, separatorIndex)] = text.slice(separatorIndex + 1);
  }
  return result;
}

function renderTagChips(row) {
  const tags = Object.entries(tagsFromRow(row));
  if (!tags.length) return '';
  return tags
    .slice(0, 4)
    .map(([key, value]) => `<span class="tag-chip" title="${escapeHtml(`${key}:${value}`)}">${escapeHtml(key)}:${escapeHtml(value)}</span>`)
    .join('');
}

function renderDetail(detail, stack) {
  const attributes = safeJson(detail.attributes_json);
  const tags = tagsFromRow(detail);
  const detailTexts = {
    message: {
      title: '消息',
      subtitle: detail.event_id || '',
      content: detail.message || detail.error_message || '',
    },
    stack: {
      title: '堆栈',
      subtitle: detail.stack_ref || '',
      content: stack || '该事件没有堆栈 blob。',
    },
    attributes: {
      title: '属性',
      subtitle: detail.event_id || '',
      content: JSON.stringify(attributes, null, 2),
    },
    tags: {
      title: 'Tags',
      subtitle: detail.event_id || '',
      content: JSON.stringify(tags, null, 2),
    },
    raw: {
      title: '原始数据',
      subtitle: detail.event_id || '',
      content: JSON.stringify(detail, null, 2),
    },
  };
  state.detailTextSections = detailTexts;
  el.drawerBody.innerHTML =
    `<section class="detail-grid">
      ${detailItem('时间', formatTime(detail.timestamp))}
      ${detailItem('租户', detail.tenant_id)}
      ${detailItem('产品', detail.product)}
      ${detailItem('主题', detail.topic)}
      ${detailItem('环境', detail.environment)}
      ${detailItem('组件', detail.component)}
      ${detailItem('版本', detail.version)}
      ${detailItem('平台', [detail.platform, detail.arch].filter(Boolean).join(' / '))}
      ${detailItem('用户标识哈希', detail.user_identifier_hash)}
      ${detailItem('用户 ID 哈希', detail.user_id_hash)}
      ${detailItem('设备哈希', detail.device_id_hash)}
      ${detailItem('会话 ID', detail.session_id)}
      ${detailItem('链路 ID', detail.trace_id)}
      ${detailItem('会话上下文', detail.conversation_id)}
      ${detailItem('错误哈希', detail.error_hash)}
    </section>
    ${detailTextSection('message', detailTexts.message.title, detailTexts.message.content, detailTexts.message.subtitle)}
    ${detailTextSection('stack', detailTexts.stack.title, detailTexts.stack.content, detailTexts.stack.subtitle)}
    ${detailTextSection('tags', detailTexts.tags.title, detailTexts.tags.content, detailTexts.tags.subtitle)}
    ${detailTextSection('attributes', detailTexts.attributes.title, detailTexts.attributes.content, detailTexts.attributes.subtitle)}
    ${detailTextSection('raw', detailTexts.raw.title, detailTexts.raw.content, detailTexts.raw.subtitle)}`;
}

function safeJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function closeDrawer() {
  closeTextDialog();
  state.detailTextSections = {};
  el.drawer.classList.remove('open');
  el.drawerBackdrop.classList.add('hidden');
  el.drawer.setAttribute('aria-hidden', 'true');
}

function openTextDialog(section) {
  state.textDialog = {
    content: section.content || '',
    query: '',
    matchCount: 0,
    currentMatch: -1,
  };
  el.textDialogTitle.textContent = section.title || '文本详情';
  el.textDialogSubtitle.textContent = section.subtitle || '';
  el.textDialogSearch.value = '';
  el.textDialog.classList.remove('hidden');
  el.textDialogBackdrop.classList.remove('hidden');
  el.textDialog.setAttribute('aria-hidden', 'false');
  renderTextDialogContent();
  el.textDialogSearch.focus({ preventScroll: true });
}

function closeTextDialog() {
  if (!el.textDialog) return;
  el.textDialog.classList.add('hidden');
  el.textDialogBackdrop.classList.add('hidden');
  el.textDialog.setAttribute('aria-hidden', 'true');
  state.textDialog = {
    content: '',
    query: '',
    matchCount: 0,
    currentMatch: -1,
  };
  el.textDialogContent.textContent = '';
}

function getTextMatches(text, query) {
  if (!query) return [];
  const matches = [];
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  let index = normalizedText.indexOf(normalizedQuery);
  while (index !== -1) {
    matches.push(index);
    index = normalizedText.indexOf(normalizedQuery, index + normalizedQuery.length);
  }
  return matches;
}

function renderTextDialogContent() {
  const text = state.textDialog.content || '';
  const query = state.textDialog.query;
  const matches = getTextMatches(text, query);
  state.textDialog.matchCount = matches.length;

  if (!matches.length) {
    state.textDialog.currentMatch = -1;
    el.textDialogContent.textContent = text;
    el.textDialogMatchCount.textContent = query ? '0/0' : '0/0';
    el.textDialogPrev.disabled = true;
    el.textDialogNext.disabled = true;
    return;
  }

  if (state.textDialog.currentMatch < 0 || state.textDialog.currentMatch >= matches.length) {
    state.textDialog.currentMatch = 0;
  }

  const parts = [];
  let cursor = 0;
  matches.forEach((matchIndex, index) => {
    parts.push(escapeHtml(text.slice(cursor, matchIndex)));
    const className = index === state.textDialog.currentMatch ? 'search-hit current' : 'search-hit';
    parts.push(`<mark class="${className}">${escapeHtml(text.slice(matchIndex, matchIndex + query.length))}</mark>`);
    cursor = matchIndex + query.length;
  });
  parts.push(escapeHtml(text.slice(cursor)));

  el.textDialogContent.innerHTML = parts.join('');
  el.textDialogMatchCount.textContent = `${state.textDialog.currentMatch + 1}/${matches.length}`;
  el.textDialogPrev.disabled = false;
  el.textDialogNext.disabled = false;
  requestAnimationFrame(() => {
    el.textDialogContent.querySelector('mark.current')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
}

function setTextDialogQuery(query) {
  state.textDialog.query = query.trim();
  state.textDialog.currentMatch = -1;
  renderTextDialogContent();
}

function moveTextDialogMatch(direction) {
  const matchCount = state.textDialog.matchCount;
  if (!matchCount) return;
  state.textDialog.currentMatch = (state.textDialog.currentMatch + direction + matchCount) % matchCount;
  renderTextDialogContent();
}

function setView(view) {
  if (view === 'users' && state.user && !hasPermission('users:manage')) view = 'discover';
  if (view === 'settings' && state.user && !hasPermission('settings:write')) view = 'discover';
  if (view === 'dashboard' && state.user && !hasPermission('logs:read')) view = 'discover';
  if (view === 'panelManager' && state.user && !canManageDashboards()) view = 'dashboard';
  state.activeView = view;
  const meta = viewMeta[view] || viewMeta.discover;
  const navView = view === 'panelManager' ? 'dashboard' : view;
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === navView);
  });
  el.pageTitle.textContent = meta.title;
  el.pageDescription.textContent = meta.description;
  el.runQuery.textContent = meta.queryButton;
  el.runQuery.classList.toggle('hidden', !(meta.showRunButton ?? meta.showQueryTools));
  el.panelManagerOpen.classList.toggle('hidden', !(view === 'dashboard' && canManageDashboards()));
  el.panelManagerBack.classList.toggle('hidden', view !== 'panelManager');
  el.filtersPanel.classList.toggle('hidden', !meta.showQueryTools);
  el.metricsPanel.classList.toggle('hidden', !meta.showMetrics);
  el.timelinePanel.classList.toggle('hidden', !meta.showTimeline);
  el.discoverView.classList.toggle('hidden', view !== 'discover');
  el.errorsView.classList.toggle('hidden', view !== 'errors');
  el.dashboardView.classList.toggle('hidden', view !== 'dashboard');
  el.panelManagerView.classList.toggle('hidden', view !== 'panelManager');
  el.systemView.classList.toggle('hidden', view !== 'system');
  el.usersView.classList.toggle('hidden', view !== 'users');
  el.settingsView.classList.toggle('hidden', view !== 'settings');
  if (view === 'dashboard') loadGrafanaEmbedConfig();
  if (view === 'panelManager') loadGrafanaEmbedConfig();
  if (view === 'system') loadSystem();
  if (view === 'users') loadUsers();
  if (view === 'settings') loadSettings();
}

function bindEvents() {
  el.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    el.loginError.textContent = '';
    try {
      await login(el.loginName.value, el.loginPassword.value);
    } catch (error) {
      el.loginError.textContent = error instanceof Error ? error.message : '登录失败';
    }
  });
  el.createUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await createUser();
  });
  el.createTenantForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await createTenant();
  });
  el.createProductForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await createProduct();
  });
  el.customPanelForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveCustomPanel();
  });
  el.customPanelTest.addEventListener('click', testCustomPanel);
  el.customPanelPreview.addEventListener('click', previewCustomPanel);
  el.customPanelPreviewFrame.addEventListener('error', () => el.customPanelPreviewPanel.classList.add('has-error'));
  el.customPanelReset.addEventListener('click', resetCustomPanelForm);
  el.customPanelsBody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const panelId = button.dataset.panelId;
    if (!panelId) return;
    if (button.dataset.action === 'edit-custom-panel') editCustomPanel(panelId);
    if (button.dataset.action === 'publish-custom-panel') await publishCustomPanel(panelId);
    if (button.dataset.action === 'delete-custom-panel') await deleteCustomPanel(panelId);
  });
  el.usersBody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const userId = button.dataset.userId;
    if (!userId) return;
    if (button.dataset.action === 'save') await updateUser(userId);
    if (button.dataset.action === 'password') await resetUserPassword(userId);
    if (button.dataset.action === 'delete') await deleteUser(userId);
  });
  el.settingsBody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const tenantId = button.dataset.tenantId;
    const product = button.dataset.product;
    if (!tenantId) return;
    if (button.dataset.action === 'toggle-products') toggleTenantProducts(tenantId);
    if (button.dataset.action === 'copy-api-key') await copyApiKey(button.dataset.apiKey || '');
    if (button.dataset.action === 'save-tenant') await updateTenant(tenantId);
    if (button.dataset.action === 'delete-tenant') await deleteTenant(tenantId);
    if (button.dataset.action === 'save-product' && product) await updateProduct(tenantId, product);
    if (button.dataset.action === 'delete-product' && product) await deleteProduct(tenantId, product);
  });
  el.logoutButton.addEventListener('click', logout);
  el.panelManagerOpen.addEventListener('click', () => setView('panelManager'));
  el.panelManagerBack.addEventListener('click', () => setView('dashboard'));
  el.runQuery.addEventListener('click', () => {
    if (state.activeView === 'dashboard') {
      refreshDashboardPanels();
      return;
    }
    runQuery();
  });
  el.tenant.addEventListener('change', renderProductFilter);
  el.dashboardRefresh.addEventListener('click', loadGrafanaEmbedConfig);
  el.dashboardTenant.addEventListener('change', () => {
    renderDashboardProductFilter();
    loadGrafanaEmbedConfig();
  });
  el.dashboardProduct.addEventListener('change', loadGrafanaEmbedConfig);
  el.dashboardRange.addEventListener('change', loadGrafanaEmbedConfig);
  el.dashboardEnvironment.addEventListener('change', loadGrafanaEmbedConfig);
  el.dashboardTagKey.addEventListener('change', loadGrafanaEmbedConfig);
  el.dashboardTagValue.addEventListener('change', loadGrafanaEmbedConfig);
  el.closeDrawer.addEventListener('click', closeDrawer);
  el.drawerBackdrop.addEventListener('click', closeDrawer);
  el.drawerBody.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-detail-text-key]');
    if (!button) return;
    const section = state.detailTextSections[button.dataset.detailTextKey];
    if (section) openTextDialog(section);
  });
  el.closeTextDialog.addEventListener('click', closeTextDialog);
  el.textDialogBackdrop.addEventListener('click', closeTextDialog);
  el.textDialogSearch.addEventListener('input', () => setTextDialogQuery(el.textDialogSearch.value));
  el.textDialogPrev.addEventListener('click', () => moveTextDialogMatch(-1));
  el.textDialogNext.addEventListener('click', () => moveTextDialogMatch(1));
  el.textDialogSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    moveTextDialogMatch(event.shiftKey ? -1 : 1);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!el.textDialog.classList.contains('hidden')) {
      closeTextDialog();
      return;
    }
    if (el.drawer.classList.contains('open')) closeDrawer();
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });
}

function init() {
  setDefaultTimeRange();
  setDashboardRangeOptions(DASHBOARD_TIME_RANGES, 'now-6h');
  resetCustomPanelForm();
  bindEvents();
  setView(state.activeView);
  loadMe();
}

init();
