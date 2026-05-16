/* ── Provider Profiles ── */
async function loadModels() {
    const selects = ['claudeModelSelect', 'codexModelSelect'];
    selects.forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = '<option value="">Fetching models...</option>'; });
    try {
        const [modelsRes, cfgRes] = await Promise.all([fetch('/ui/models'), fetch('/ui/config')]);
        if (!modelsRes.ok) throw new Error('HTTP ' + modelsRes.status);
        allModels = await modelsRes.json();
        if (!Array.isArray(allModels)) throw new Error('Expected array');
        selects.forEach(id => populateSelect(id, allModels));
        const cfg = await cfgRes.json();
        applyConfigToUI(cfg);
    } catch (e) {
        console.error('[UI] Failed to load models:', e);
        showStatus('Model fetch failed: ' + e.message, 'bg-red-100 text-red-800');
        selects.forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = '<option value="">Error loading</option>'; });
    }
}

const FALLBACK_MODELS = [
    { id: 'minimax-m2.5-free', name: 'minimax-m2.5-free', provider: 'Fallback' },
    { id: 'ling-2.6-flash-free', name: 'ling-2.6-flash-free', provider: 'Fallback' },
    { id: 'hy3-preview-free', name: 'hy3-preview-free', provider: 'Fallback' },
    { id: 'gemini-2.0-flash-exp-free', name: 'gemini-2.0-flash-exp-free', provider: 'Fallback' }
];

function populateSelect(id, models) {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Select a model...</option>';
    models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id; opt.innerText = m.name || m.id;
        opt.dataset.url = m.url || ''; opt.dataset.key = m.key || ''; opt.dataset.base = m.base || '';
        select.appendChild(opt);
    });
    if (current) select.value = current;
}

function onModelChange(profile) {
    const select = document.getElementById(profile + 'ModelSelect');
    const opt = select.options[select.selectedIndex];
    if (!opt || !opt.value) return;
    if (opt.dataset.base || opt.dataset.url) { document.getElementById(profile + 'TargetUrl').value = normalizeTargetUrlForProfile(profile, opt.dataset.base || opt.dataset.url); }
    const apiKeyField = document.getElementById(profile + 'ApiKey');
    if (opt.dataset.key && !apiKeyField.value.trim()) { apiKeyField.value = opt.dataset.key; }
    const statusModel = profile === 'claude' ? getClaudePublicAliasValue() : opt.value;
    document.getElementById(profile + 'StatusModel').innerText = statusModel;
    document.getElementById(profile + 'StatusProvider').innerText = extractProvider(opt.dataset.base || opt.dataset.url);
    syncSummaryFromUI();
    refreshContextWindow(profile);
}

function getClaudePublicAliasValue() {
    const input = document.getElementById('claudePublicModel');
    return (input?.value || '').trim() || DEFAULT_CLAUDE_PUBLIC_ALIAS;
}

function onClaudeAliasChange() {
    const alias = getClaudePublicAliasValue();
    const statusModel = document.getElementById('claudeStatusModel');
    const statusAlias = document.getElementById('claudeStatusAlias');
    if (statusModel) statusModel.innerText = alias;
    if (statusAlias) { statusAlias.innerText = 'Public alias: ' + alias; statusAlias.title = alias; }
    syncSummaryFromUI();
}

async function refreshContextWindow(profile) {
    const model = document.getElementById(profile + 'ModelSelect').value;
    if (!model) return;
    try {
        const res = await fetch('/ui/context?model=' + encodeURIComponent(model));
        const data = await res.json();
        const inputTokens = data.inputTokens || 32768;
        document.getElementById(profile + 'ContextWindow').value = inputTokens.toLocaleString() + ' tokens';
        document.getElementById(profile + 'StatusContext').innerText = formatTokenCount(inputTokens) + ' ctx';
    } catch (e) { console.error('Context window refresh failed:', e); }
}

function formatTokenCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

function formatExactNumber(n) { return Number(n || 0).toLocaleString(); }

function formatUsd(value) {
    const amount = Number(value || 0);
    return '$' + amount.toLocaleString(undefined, { minimumFractionDigits: amount >= 1 ? 2 : 4, maximumFractionDigits: amount >= 1 ? 2 : 4 });
}

function getLiveProfileRate(profile, direction) {
    const suffix = direction === 'in' ? 'InCost' : 'OutCost';
    const field = document.getElementById('overview' + profile.charAt(0).toUpperCase() + profile.slice(1) + suffix);
    const value = Number(field?.value || 0);
    return Number.isFinite(value) ? value : 0;
}

function getDisplayCosts(stats) {
    const profileStats = stats?.profileStats || {};
    const hasProfileBreakdown = ['claude', 'codex'].some(profile => { const entry = profileStats[profile]; return entry && ((entry.inputTokens || 0) > 0 || (entry.outputTokens || 0) > 0); });
    if (!hasProfileBreakdown) { return { inputCost: Number(stats?.estimatedInputCost || 0), outputCost: Number(stats?.estimatedOutputCost || 0), totalCost: Number(stats?.estimatedTotalCost || 0) }; }
    let inputCost = 0; let outputCost = 0;
    ['claude', 'codex'].forEach(profile => { const entry = profileStats[profile] || {}; inputCost += ((entry.inputTokens || 0) / 1000000) * getLiveProfileRate(profile, 'in'); outputCost += ((entry.outputTokens || 0) / 1000000) * getLiveProfileRate(profile, 'out'); });
    return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

function rerenderCostSummary() {
    if (!latestStatsSnapshot) return;
    const costs = getDisplayCosts(latestStatsSnapshot);
    document.getElementById('statusTotalCost').innerText = formatUsd(costs.totalCost);
    document.getElementById('statusCostBreakdown').innerText = 'In ' + formatUsd(costs.inputCost) + ' / Out ' + formatUsd(costs.outputCost);
}

function extractProvider(url) {
    if (!url) return 'Unknown';
    try {
        const host = new URL(url).hostname;
        if (host.includes('kilo')) return 'Kilocode';
        if (host.includes('opencode')) return 'Opencode';
        if (host.includes('openrouter')) return 'OpenRouter';
        if (host.includes('nvidia')) return 'NVIDIA';
        if (host.includes('localhost') || host.includes('127.0.0.1')) return 'Local';
        return host.split('.')[0];
    } catch { return 'Custom'; }
}

function extractApiBaseUrl(url) {
    if (!url) return '--';
    try {
        const parsed = new URL(url);
        return parsed.href.replace(/\/v1\/messages$/i, '').replace(/\/v1\/chat\/completions$/i, '').replace(/\/v1\/responses$/i, '').replace(/\/v1\/text\/chatcompletion_v2$/i, '').replace(/\/chat\/completions$/i, '').replace(/\/responses$/i, '').replace(/\/messages$/i, '');
    } catch { return url; }
}

function isMiniMaxRoute(url) { return typeof url === 'string' && url.toLowerCase().includes('minimax'); }
function isAnthropicRoute(url) { return typeof url === 'string' && (url.toLowerCase().includes('/anthropic') || url.toLowerCase().includes('/v1/messages') || url.toLowerCase().includes('anthropic.com')); }

function getOptimizationSummary(profileCfg, profileName) {
    if (!profileCfg) return 'No optimization metadata available yet.';
    const route = profileCfg.targetUrl || '';
    const upstreamModel = profileCfg._upstreamModel || profileCfg.currentModel || '';
    const isMiniMax = isMiniMaxRoute(route) || String(upstreamModel).toLowerCase().includes('minimax');
    if (!isMiniMax) return 'Standard compatibility mode.';
    if (profileName === 'claude' || isAnthropicRoute(route)) return 'MiniMax native-thinking mode: Anthropic thinking blocks and interleaved tool reasoning are preserved end-to-end.';
    return 'MiniMax optimized OpenAI mode: reasoning_split, structured reasoning_details, managed tool-round reasoning carryover, and 8,192-token default output reserve.';
}

function getLiveProfileState(profile) {
    const existing = currentConfigState?.[profile] || {};
    const route = document.getElementById(profile + 'TargetUrl')?.value || existing.targetUrl || '';
    const model = profile === 'claude' ? (document.getElementById('claudeModelSelect')?.value || existing._upstreamModel || existing.currentModel || '') : (document.getElementById('codexModelSelect')?.value || existing.currentModel || '');
    return { ...existing, targetUrl: route, currentModel: profile === 'claude' ? (existing.currentModel || getClaudePublicAliasValue()) : model, _upstreamModel: profile === 'claude' ? model : existing._upstreamModel };
}

function formatReasoningDetail(detail, index) {
    const meta = [];
    if (detail?.id) meta.push(`id: ${detail.id}`);
    if (detail?.format) meta.push(`format: ${detail.format}`);
    if (detail?.signature) meta.push(`signature: ${detail.signature}`);
    const body = detail?.text || detail?.thinking || '';
    return { tone: 'indigo', title: `Reasoning Detail ${index + 1}`, content: `${meta.length > 0 ? meta.join('\n') + '\n\n' : ''}${body}`.trim() };
}

function sanitizeDisplayedRequestText(text) {
    if (typeof text !== 'string' || !text.trim()) return '';
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

function extractRequestMessageSummary(requestBody) {
    const parsed = parseStructuredValue(requestBody);
    if (!parsed) return '';
    const parts = [];
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    messages.forEach(message => {
        if (!message || typeof message !== 'object') return;
        if (message.role === 'user') {
            if (typeof message.content === 'string' && message.content.trim()) { parts.push(message.content.trim()); }
            else if (Array.isArray(message.content)) { message.content.forEach(block => { if (block?.type === 'text' && block.text) parts.push(block.text.trim()); }); }
        }
    });
    if (parts.length > 0) return sanitizeDisplayedRequestText(parts.join('\n\n'));
    if (typeof parsed.input === 'string') return sanitizeDisplayedRequestText(parsed.input);
    if (typeof parsed.prompt === 'string') return sanitizeDisplayedRequestText(parsed.prompt);
    return '';
}

function extractThinkingSummary(item, responsePanels) {
    const rawThinking = typeof item?.thinking === 'string' ? item.thinking.trim() : '';
    if (rawThinking) return rawThinking;
    const thinkingPanels = (responsePanels || []).filter(panel => panel.tone === 'indigo');
    if (thinkingPanels.length === 0) return '';
    return thinkingPanels.map(panel => { const title = panel.title ? `[${panel.title}]` : ''; return `${title}${title ? '\n' : ''}${panel.content || ''}`.trim(); }).filter(Boolean).join('\n\n');
}

function renderThinkingTraceCard(item, responsePanels) {
    const requestText = extractRequestMessageSummary(item?.requestBody);
    const thinkingText = extractThinkingSummary(item, responsePanels);
    if (!thinkingText) return '';
    const sectionBlock = (title, content, tone) => {
        if (!content) return '';
        const tones = { slate: { box: 'bg-slate-50 dark:bg-slate-900', title: 'text-slate-700 dark:text-slate-200', body: 'text-slate-800 dark:text-slate-100' }, indigo: { box: 'bg-indigo-50 dark:bg-indigo-900/20', title: 'text-indigo-700 dark:text-indigo-300', body: 'text-indigo-900 dark:text-indigo-200' } };
        const style = tones[tone] || tones.slate;
        return `<div class="${style.box} rounded-lg p-3"><p class="text-[10px] font-bold ${style.title} uppercase mb-1">${escapeHtml(title)}</p><pre class="text-xs ${style.body} whitespace-pre-wrap font-mono leading-relaxed">${escapeHtml(content)}</pre></div>`;
    };
    return `<div class="rounded-lg border border-indigo-200 dark:border-indigo-800 bg-white/70 dark:bg-slate-900 p-3 space-y-3"><p class="text-[10px] font-bold text-indigo-700 dark:text-indigo-300 uppercase">Thinking Trace</p>${sectionBlock('Model Thinking', thinkingText, 'indigo')}</div>`;
}

function stripKnownEndpointSuffixes(url) {
    return (url || '').replace(/\/v1\/messages$/i, '').replace(/\/messages$/i, '').replace(/\/v1\/chat\/completions$/i, '').replace(/\/chat\/completions$/i, '').replace(/\/v1\/responses$/i, '').replace(/\/responses$/i, '').replace(/\/v1\/models$/i, '').replace(/\/models$/i, '');
}

function normalizeTargetUrlForProfile(profile, targetUrl) {
    if (!targetUrl) return '';
    const lower = targetUrl.toLowerCase();
    const isOpenAI = lower.includes('openai.com') || lower.includes('openrouter.ai') || lower.includes('groq.com') || lower.includes('completions') || lower.includes('localhost:11434');
    try {
        const stripped = stripKnownEndpointSuffixes(targetUrl);
        const parsed = new URL(stripped);
        const root = `${parsed.protocol}//${parsed.host}`;
        const path = parsed.pathname.replace(/\/$/, '');
        if (profile === 'claude' && !isOpenAI) {
            if (parsed.hostname === 'api.minimax.io') return `${root}/anthropic/v1/messages`;
            if (parsed.hostname === 'api.anthropic.com') return `${root}/v1/messages`;
            if (/\/anthropic$/i.test(path)) return `${root}${path}/v1/messages`;
            if (/\/v\d+$/i.test(path)) return `${root}${path.replace(/\/v\d+$/i, '')}/v1/messages`;
            return `${root}${path}/v1/messages`;
        }
        if (parsed.hostname === 'api.minimax.io') return `${root}/v1/text/chatcompletion_v2`;
        if (/\/v\d+$/i.test(path)) return `${root}${path}/chat/completions`;
        return `${root}${path}/v1/chat/completions`;
    } catch { return targetUrl; }
}

function detectCustomProviderProfile(baseUrl) {
    const normalized = (baseUrl || '').toLowerCase();
    if (normalized.includes('/anthropic') || normalized.includes('anthropic.com')) return 'claude';
    return 'codex';
}

function getPeriodQueryString(period = currentPeriod) {
    const params = new URLSearchParams();
    params.set('period', period);
    params.set('tzOffsetMinutes', String(new Date().getTimezoneOffset()));
    let weekStartsOn = 0;
    try { const firstDay = new Intl.Locale(navigator.language).weekInfo?.firstDay; if (typeof firstDay === 'number') { weekStartsOn = firstDay % 7; } } catch (e) {}
    params.set('weekStartsOn', String(weekStartsOn));
    return params.toString();
}

function setPeriod(period) {
    currentPeriod = period;
    document.querySelectorAll('.period-btn').forEach(btn => { btn.classList.remove('bg-white', 'dark:bg-slate-700', 'dark:bg-slate-800', 'text-slate-700', 'dark:text-slate-200', 'shadow-sm'); btn.classList.add('text-slate-500', 'dark:text-slate-400'); });
    document.querySelectorAll(`.period-btn[data-period="${period}"]`).forEach(activeBtn => { activeBtn.classList.remove('text-slate-500', 'dark:text-slate-400'); activeBtn.classList.add('bg-white', 'dark:bg-slate-700', 'text-slate-700', 'dark:text-slate-200', 'shadow-sm'); });
    reconnectSSE(); loadRequests(); loadInspector();
    if (sectionVisible('thinking')) loadThinking();
}

function syncCostToProfile(profile, type) {
    const overviewId = 'overview' + profile.charAt(0).toUpperCase() + profile.slice(1) + (type === 'in' ? 'InCost' : 'OutCost');
    const profileId = profile + (type === 'in' ? 'InputCostPer1M' : 'OutputCostPer1M');
    const overviewVal = document.getElementById(overviewId).value;
    const profileEl = document.getElementById(profileId);
    if (profileEl) profileEl.value = overviewVal;
    rerenderCostSummary();
}

function syncProfileToOverview(profile) {
    const profileInEl = document.getElementById(profile + 'InputCostPer1M');
    const profileOutEl = document.getElementById(profile + 'OutputCostPer1M');
    const overviewInEl = document.getElementById('overview' + profile.charAt(0).toUpperCase() + profile.slice(1) + 'InCost');
    const overviewOutEl = document.getElementById('overview' + profile.charAt(0).toUpperCase() + profile.slice(1) + 'OutCost');
    if (profileInEl && overviewInEl) overviewInEl.value = profileInEl.value || '';
    if (profileOutEl && overviewOutEl) overviewOutEl.value = profileOutEl.value || '';
}

async function fetchCustomModels() {
    const btn = event.target;
    const originalText = btn.innerText;
    btn.innerText = 'Fetching...'; btn.disabled = true;
    const baseUrl = document.getElementById('customBaseUrl').value.trim();
    const apiKey = document.getElementById('customApiKey').value.trim();
    if (!baseUrl) { showStatus('Please enter a base URL', 'bg-red-100 text-red-800'); btn.innerText = originalText; btn.disabled = false; return; }
    try {
        const res = await fetch('/ui/custom-models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl, apiKey }) });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const select = document.getElementById('customModelSelect');
        select.innerHTML = '';
        if (data.length === 0) { select.innerHTML = '<option value="">No models found</option>'; showStatus('No models found at this provider', 'bg-yellow-100 text-yellow-800'); }
        else { data.forEach(m => { const opt = document.createElement('option'); opt.value = m.id; opt.innerText = m.name; opt.dataset.url = m.url; opt.dataset.base = m.base; select.appendChild(opt); }); showStatus(`Found ${data.length} models`, 'bg-green-100 text-green-800'); }
    } catch (e) { showStatus('Fetch failed: ' + e.message, 'bg-red-100 text-red-800'); }
    finally { btn.innerText = originalText; btn.disabled = false; }
}

async function testCustomProvider() {
    const btn = event.target;
    const originalText = btn.innerText;
    btn.innerText = 'Testing...'; btn.disabled = true;
    const baseUrl = document.getElementById('customBaseUrl').value.trim();
    const apiKey = document.getElementById('customApiKey').value.trim();
    const select = document.getElementById('customModelSelect');
    const model = select.value;
    const profile = detectCustomProviderProfile(baseUrl);
    if (!baseUrl) { showStatus('Please enter a base URL', 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200'); btn.innerText = originalText; btn.disabled = false; return; }
    try {
        const res = await fetch('/ui/custom-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl, apiKey, model, profile }) });
        const result = await res.json();
        if (result.success) { showTestResult('Custom Provider Test Success', result.content, false); }
        else { showTestResult('Custom Provider Test Failed', result.error, true); }
    } catch (e) { showTestResult('Custom Provider Test Error', e.message, true); }
    finally { btn.innerText = originalText; btn.disabled = false; }
}

function applyCustomModel(profile) {
    const select = document.getElementById('customModelSelect');
    const opt = select.options[select.selectedIndex];
    if (!opt || !opt.value) { showStatus('Please select a model first', 'bg-red-100 text-red-800'); return; }
    const previousModel = document.getElementById(profile + 'ModelSelect').value;
    document.getElementById(profile + 'ModelSelect').innerHTML = '';
    const clone = opt.cloneNode(true);
    document.getElementById(profile + 'ModelSelect').appendChild(clone);
    document.getElementById(profile + 'ModelSelect').value = opt.value;
    const normalizedTargetUrl = normalizeTargetUrlForProfile(profile, opt.dataset.base || opt.dataset.url || document.getElementById('customBaseUrl').value);
    document.getElementById(profile + 'TargetUrl').value = normalizedTargetUrl;
    document.getElementById(profile + 'ApiKey').value = document.getElementById('customApiKey').value;
    const publicModel = profile === 'claude' ? getClaudePublicAliasValue() : 'gpt-5.4';
    const upstreamModel = opt.value;
    document.getElementById(profile + 'StatusModel').innerText = publicModel;
    document.getElementById(profile + 'StatusProvider').innerText = 'Custom';
    document.getElementById(profile + 'InputCostPer1M').value = document.getElementById('customInputCostPer1M').value || '';
    document.getElementById(profile + 'OutputCostPer1M').value = document.getElementById('customOutputCostPer1M').value || '';
    if (previousModel && previousModel !== upstreamModel) clearProfileContextState(profile);
    if (!currentConfigState[profile]) currentConfigState[profile] = {};
    currentConfigState[profile] = { ...currentConfigState[profile], currentModel: publicModel, _upstreamModel: upstreamModel, targetUrl: normalizedTargetUrl, apiKey: document.getElementById('customApiKey').value || '' };
    currentConfigState.customProvider = { baseUrl: document.getElementById('customBaseUrl').value || '', apiKey: document.getElementById('customApiKey').value || '' };
    updateConfigDisplay(currentConfigState);
    if (profile === 'claude') onClaudeAliasChange();
    syncSummaryFromUI();
    refreshContextWindow(profile);
    showStatus(`Applied ${opt.value} to ${profile.toUpperCase()}. Click Save to persist.`, 'bg-green-100 text-green-800');
}

async function saveProfileConfig(profile) {
    const previousModel = profile === 'claude' ? (currentConfigState[profile]?._upstreamModel || currentConfigState[profile]?.currentModel) : currentConfigState[profile]?.currentModel;
    const normalizedTargetUrl = normalizeTargetUrlForProfile(profile, document.getElementById(profile + 'TargetUrl').value);
    const capitalProfile = profile.charAt(0).toUpperCase() + profile.slice(1);
    const inCostEl = document.getElementById('overview' + capitalProfile + 'InCost');
    const outCostEl = document.getElementById('overview' + capitalProfile + 'OutCost');
    const data = {
        profile: profile,
        currentModel: profile === 'claude' ? getClaudePublicAliasValue() : document.getElementById(profile + 'ModelSelect').value,
        targetUrl: normalizedTargetUrl,
        apiKey: document.getElementById(profile + 'ApiKey').value,
        contextWindow: document.getElementById(profile + 'ContextWindow').value.replace(/[^0-9]/g, ''),
        inputCostPer1M: inCostEl ? inCostEl.value : '',
        outputCostPer1M: outCostEl ? outCostEl.value : ''
    };
    if (profile === 'claude') { data._upstreamModel = document.getElementById('claudeModelSelect').value; }
    document.getElementById(profile + 'TargetUrl').value = normalizedTargetUrl;
    const customBaseUrl = document.getElementById('customBaseUrl').value;
    const customApiKey = document.getElementById('customApiKey').value;
    if (customBaseUrl) { data.customProvider = { baseUrl: customBaseUrl, apiKey: customApiKey }; }
    const res = await fetch('/ui/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) {
        const nextModel = profile === 'claude' ? (data._upstreamModel || data.currentModel) : data.currentModel;
        if (previousModel && previousModel !== nextModel) clearProfileContextState(profile);
        if (!currentConfigState[profile]) currentConfigState[profile] = {};
        currentConfigState[profile] = { ...currentConfigState[profile], currentModel: data.currentModel, _upstreamModel: profile === 'claude' ? data._upstreamModel : currentConfigState[profile]?._upstreamModel, targetUrl: data.targetUrl, apiKey: data.apiKey, inputCostPer1M: Number(data.inputCostPer1M) || 0, outputCostPer1M: Number(data.outputCostPer1M) || 0 };
        if (data.customProvider) currentConfigState.customProvider = data.customProvider;
        updateConfigDisplay(currentConfigState);
        showStatus(profile.toUpperCase() + ' profile saved!', 'bg-green-100 text-green-800');
        document.getElementById(profile + 'StatusModel').innerText = data.currentModel;
        if (profile === 'claude') onClaudeAliasChange();
        document.getElementById(profile + 'StatusProvider').innerText = extractProvider(data.targetUrl);
        syncSummaryFromUI();
    }
}

async function saveTrafficSettings() {
    const requestLogLimit = Number.parseInt(document.getElementById('requestLogLimit').value, 10);
    const pendingTimeoutMinutes = Number.parseInt(document.getElementById('pendingTimeoutMinutes').value, 10);
    const payload = {
        requestLogLimit: Number.isFinite(requestLogLimit) && requestLogLimit > 0 ? requestLogLimit : DEFAULT_REQUEST_LOG_LIMIT,
        pendingRequestTimeoutMinutes: Number.isFinite(pendingTimeoutMinutes) && pendingTimeoutMinutes > 0 ? pendingTimeoutMinutes : DEFAULT_PENDING_TIMEOUT_MINUTES
    };
    const res = await fetch('/ui/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { showStatus('Failed to save traffic settings', 'bg-red-100 text-red-800'); return; }
    currentConfigState = { ...currentConfigState, requestLogLimit: payload.requestLogLimit, pendingRequestTimeoutMinutes: payload.pendingRequestTimeoutMinutes };
    updateConfigDisplay(currentConfigState);
    showStatus('Traffic settings saved!', 'bg-green-100 text-green-800');
}

async function testProfileConfig(profile) {
    const btn = event.target;
    const originalText = btn.innerText;
    btn.innerText = 'Testing...'; btn.disabled = true;
    const data = { profile: profile, model: document.getElementById(profile + 'ModelSelect').value, targetUrl: normalizeTargetUrlForProfile(profile, document.getElementById(profile + 'TargetUrl').value), apiKey: document.getElementById(profile + 'ApiKey').value };
    try {
        const res = await fetch('/ui/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const result = await res.json();
        if (result.success) { showTestResult('Test Success', result.content, false); }
        else { showTestResult('Test Failed', result.error, true); }
    } catch (e) { showTestResult('Test Error', e.message, true); }
    finally { btn.innerText = originalText; btn.disabled = false; }
}

/* ── Bookmarks ── */
async function loadBookmarks() {
    try {
        const res = await fetch('/ui/bookmarks');
        bookmarkList = await res.json();
        const select = document.getElementById('bookmarkSelect');
        select.innerHTML = '<option value="">-- Select a saved provider --</option>';
        bookmarkList.forEach(b => { const opt = document.createElement('option'); opt.value = b.name; opt.innerText = b.name; select.appendChild(opt); });
    } catch (e) { console.error('Failed to load bookmarks:', e); }
}

function selectBookmark(name) {
    const bookmark = bookmarkList.find(b => b.name === name);
    if (bookmark) {
        document.getElementById('customBaseUrl').value = bookmark.baseUrl || '';
        document.getElementById('customApiKey').value = bookmark.apiKey || '';
        document.getElementById('customInputCostPer1M').value = bookmark.inputCostPer1M || '';
        document.getElementById('customOutputCostPer1M').value = bookmark.outputCostPer1M || '';
        document.getElementById('customModelSelect').innerHTML = '<option value="">Click Fetch Models to load</option>';
        showStatus(`Loaded bookmark: ${bookmark.name}`, 'bg-blue-100 text-blue-800');
    }
}

async function saveCurrentBookmark() {
    const baseUrl = document.getElementById('customBaseUrl').value.trim();
    const apiKey = document.getElementById('customApiKey').value.trim();
    if (!baseUrl) { showStatus('Enter a base URL first', 'bg-red-100 text-red-800'); return; }
    const name = prompt('Name this provider bookmark:', extractProvider(baseUrl) || 'My Provider');
    if (!name) return;
    try {
        const res = await fetch('/ui/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, baseUrl, apiKey, inputCostPer1M: document.getElementById('customInputCostPer1M').value || 0, outputCostPer1M: document.getElementById('customOutputCostPer1M').value || 0 }) });
        const data = await res.json();
        if (data.success) { bookmarkList = data.bookmarks; loadBookmarks(); setTimeout(() => { document.getElementById('bookmarkSelect').value = name; }, 100); showStatus(`Bookmark "${name}" saved!`, 'bg-green-100 text-green-800'); }
    } catch (e) { showStatus('Error saving bookmark: ' + e.message, 'bg-red-100 text-red-800'); }
}

async function deleteSelectedBookmark() {
    const select = document.getElementById('bookmarkSelect');
    const name = select.value;
    if (!name) { showStatus('Select a bookmark to delete', 'bg-yellow-100 text-yellow-800'); return; }
    if (!confirm(`Delete bookmark "${name}"?`)) return;
    try {
        const res = await fetch('/ui/bookmarks/' + encodeURIComponent(name), { method: 'DELETE' });
        const data = await res.json();
        if (data.success) { bookmarkList = data.bookmarks; loadBookmarks(); select.value = ''; showStatus(`Bookmark "${name}" deleted`, 'bg-green-100 text-green-800'); }
    } catch (e) { showStatus('Error deleting bookmark: ' + e.message, 'bg-red-100 text-red-800'); }
}
