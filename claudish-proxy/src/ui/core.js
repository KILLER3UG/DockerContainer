/* ── Sub-tab switching ── */
function switchSubTab(group, tabName, btn) {
    document.querySelectorAll(`.sub-tab-panel[data-tab-group="${group}"]`).forEach(p => p.classList.remove('active'));
    const target = document.querySelector(`.sub-tab-panel[data-tab-group="${group}"][data-tab="${tabName}"]`);
    if (target) target.classList.add('active');
    if (btn) {
        btn.closest('.sub-tabs').querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
    }
}

let allModels = [];
let currentPeriod = 'all';
let bookmarkList = [];
let inspectorData = [];
let thinkingData = [];
let expandedReqId = null;
let expandedThinkingReqId = null;
let activeSection = localStorage.getItem('claudish-active-section') || 'overview';
let currentConfigState = {};
let latestStatsSnapshot = null;
let lastActivityRenderKey = '';
let lastRequestsRenderKey = '';
let lastStatsRenderKey = '';
let lastInspectorRenderKey = '';
let lastThinkingRenderKey = '';
let pollHandles = [];
let debugErrorCount = 0;
let liveStream = null;
let liveStreamGeneration = 0;
let _sseRetryTimeout = null;
let mcpServerListState = [];
let skillListState = [];
let pluginListState = [];
let compatibilityState = null;
let healthState = null;
let memoryItemState = [];
let workbenchSession = null;
const DEFAULT_MEMORY_CONTEXT_MAX_CHARS = 24000;
const MAX_MEMORY_CONTEXT_CHARS = 64000;

function sectionVisible(...sections) {
    return sections.includes(activeSection);
}

function updateDebugStamp(kind, message) {
    const idMap = { requests: 'debugRequestsAt', activity: 'debugActivityAt', inspector: 'debugInspectorAt' };
    const el = document.getElementById(idMap[kind]);
    if (!el) return;
    const now = new Date();
    const stamp = now.toLocaleTimeString();
    el.innerText = message ? `${stamp} (${message})` : stamp;
}

function reportLiveError(scope, error) {
    debugErrorCount += 1;
    const countEl = document.getElementById('debugErrorCount');
    const errEl = document.getElementById('debugLastError');
    if (countEl) countEl.innerText = String(debugErrorCount);
    if (errEl) {
        errEl.classList.remove('hidden');
        errEl.innerText = `${scope}: ${error?.message || error || 'unknown error'}`;
    }
    console.error(`[UI ${scope}]`, error);
}

function clearProfileContextState(profile) {
    const field = document.getElementById(profile + 'ContextWindow');
    const status = document.getElementById(profile + 'StatusContext');
    if (field) field.value = '';
    if (status) status.innerText = '--';
    if (currentConfigState[profile]) {
        delete currentConfigState[profile].contextWindow;
        delete currentConfigState[profile].contextModelId;
    }
}

const DEFAULT_CLAUDE_PUBLIC_ALIAS = 'claude-opus-4-6';
const DEFAULT_REQUEST_LOG_LIMIT = 5000;
const DEFAULT_PENDING_TIMEOUT_MINUTES = 10;

/* ── Navigation ── */
function switchSection(section) {
    activeSection = section;
    localStorage.setItem('claudish-active-section', section);
    document.querySelectorAll('.dashboard-section').forEach(el => {
        el.classList.toggle('hidden', el.id !== 'section-' + section);
    });
    document.querySelectorAll('.section-nav').forEach(btn => {
        const isActive = btn.dataset.section === section;
        if (btn.classList.contains('rounded-full')) {
            btn.classList.toggle('bg-slate-900', isActive);
            btn.classList.toggle('text-white', isActive);
            btn.classList.toggle('border-slate-900', isActive);
            btn.classList.toggle('dark:bg-slate-100', isActive);
            btn.classList.toggle('dark:text-slate-900', isActive);
            btn.classList.toggle('dark:border-slate-100', isActive);
        } else {
            btn.classList.toggle('bg-slate-900', isActive);
            btn.classList.toggle('text-white', isActive);
            btn.classList.toggle('shadow-sm', isActive);
            btn.classList.toggle('dark:bg-slate-100', isActive);
            btn.classList.toggle('dark:text-slate-900', isActive);
        }
    });
    setPeriod(currentPeriod);
    if (sectionVisible('overview', 'traffic')) loadRequests();
    if (sectionVisible('overview')) loadActivity();
    if (sectionVisible('health')) loadHealthUI();
    if (sectionVisible('workbench')) { ensureWorkbenchSession(); loadComputerUseStatus(); }
    if (sectionVisible('inspector')) loadInspector();
    if (sectionVisible('thinking')) loadThinking();
    if (sectionVisible('memory')) loadMemoryItemsUI();
    if (sectionVisible('mcp')) loadMcpSkillsUI();
    if (sectionVisible('august')) loadAugustUI();
}

/* ── UI Utilities ── */
function toggleApiKeyVisibility(inputId, button) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.innerText = reveal ? '🙈' : '👁';
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function prettyJson(obj) {
    if (!obj) return '';
    try { return JSON.stringify(typeof obj === 'string' ? JSON.parse(obj) : obj, null, 2); }
    catch (e) { return String(obj); }
}

function parseStructuredValue(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try { return JSON.parse(value); }
    catch (e) { return null; }
}

function stringifyPanelContent(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return prettyJson(value);
}

function extractFilePathsFromValue(value) {
    const seen = new Set();
    const paths = [];
    function visit(input) {
        if (!input) return;
        if (typeof input === 'string') {
            const pathPattern = /(?:[A-Za-z]:\\[^\s"'`<>|]+|\/[A-Za-z0-9._\-\/\\]+|(?:^|[\s{[])(?:src|app|lib|public|tests?|docs|scripts|utils|adapters)[\/\\][^\s"'`<>|]+)/g;
            const matches = input.match(pathPattern) || [];
            matches.forEach(match => {
                const cleaned = String(match).trim().replace(/^[{[]/, '').replace(/[,\]}]$/, '');
                if (!cleaned || seen.has(cleaned)) return;
                seen.add(cleaned);
                paths.push(cleaned);
            });
            return;
        }
        if (Array.isArray(input)) { input.forEach(visit); return; }
        if (typeof input === 'object') {
            Object.entries(input).forEach(([key, val]) => {
                if (/(path|file|filename|target|glob|pattern|search_path|relative_path)/i.test(key)) {
                    visit(val);
                } else if (typeof val === 'object' || typeof val === 'string') { visit(val); }
            });
        }
    }
    visit(value);
    return paths.slice(0, 8);
}

function classifyToolAction(name) {
    const lowered = String(name || '').toLowerCase();
    if (/(read|open|view|fetch|get_file|cat)/.test(lowered)) return 'Read';
    if (/(write|edit|patch|replace|create|insert|delete|move|rename|apply)/.test(lowered)) return 'Change';
    if (/(glob|ls|find|search|grep|rg|list)/.test(lowered)) return 'Search';
    return 'Tool';
}

function isFileInteraction(name, args, output) {
    const lowered = String(name || '').toLowerCase();
    if (/(read|write|edit|patch|replace|file|path|glob|grep|find|ls|open|view|cat|delete|move|rename)/.test(lowered)) return true;
    return extractFilePathsFromValue(args).length > 0 || extractFilePathsFromValue(output).length > 0;
}

function buildToolInteraction(kind, payload, source) {
    if (!payload || typeof payload !== 'object') return null;
    const name = payload.name || payload.tool_name || 'unknown';
    const args = payload.arguments ?? payload.input ?? payload.args ?? null;
    const output = payload.output ?? payload.content ?? payload.result ?? null;
    const paths = [...extractFilePathsFromValue(args), ...extractFilePathsFromValue(output)].filter((value, index, arr) => arr.indexOf(value) === index);
    return { kind, source, name, id: payload.id || payload.tool_use_id || payload.tool_call_id || '', action: classifyToolAction(name), isFile: isFileInteraction(name, args, output), paths, argumentsText: stringifyPanelContent(args), outputText: stringifyPanelContent(output) };
}

function extractToolInteractions(item) {
    const interactions = [];
    const requestBody = parseStructuredValue(item.requestBody);
    const responseBody = parseStructuredValue(item.responseBody);
    function pushIfPresent(interaction) {
        if (!interaction) return;
        if (!interaction.argumentsText && !interaction.outputText && interaction.paths.length === 0) return;
        interactions.push(interaction);
    }
    function scanMessages(messages, source) {
        if (!Array.isArray(messages)) return;
        messages.forEach(message => {
            if (!message || typeof message !== 'object') return;
            if (Array.isArray(message.tool_calls)) {
                message.tool_calls.forEach(tc => { pushIfPresent(buildToolInteraction('call', { id: tc.id, name: tc.function?.name, arguments: parseStructuredValue(tc.function?.arguments) || tc.function?.arguments }, source)); });
            }
            if (message.role === 'tool') { pushIfPresent(buildToolInteraction('result', { id: message.tool_call_id, name: 'tool_result', output: parseStructuredValue(message.content) || message.content }, source)); }
            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (!block || typeof block !== 'object') return;
                    if (block.type === 'tool_use') { pushIfPresent(buildToolInteraction('call', { id: block.id, name: block.name, input: block.input }, source)); }
                    else if (block.type === 'tool_result') { pushIfPresent(buildToolInteraction('result', { id: block.tool_use_id, name: 'tool_result', output: block.content }, source)); }
                });
            }
        });
    }
    function scanTopLevel(parsed, source) {
        if (!parsed || typeof parsed !== 'object') return;
        scanMessages(parsed.messages, source);
        if (Array.isArray(parsed.content)) {
            parsed.content.forEach(block => {
                if (!block || typeof block !== 'object') return;
                if (block.type === 'tool_use') { pushIfPresent(buildToolInteraction('call', { id: block.id, name: block.name, input: block.input }, source)); }
                else if (block.type === 'tool_result') { pushIfPresent(buildToolInteraction('result', { id: block.tool_use_id, name: 'tool_result', output: block.content }, source)); }
            });
        }
        const choice = parsed.choices?.[0];
        if (choice?.message?.tool_calls) {
            choice.message.tool_calls.forEach(tc => { pushIfPresent(buildToolInteraction('call', { id: tc.id, name: tc.function?.name, arguments: parseStructuredValue(tc.function?.arguments) || tc.function?.arguments }, source)); });
        }
        if (Array.isArray(parsed.output)) {
            parsed.output.forEach(entry => {
                if (!entry || typeof entry !== 'object') return;
                if (entry.type === 'function_call') { pushIfPresent(buildToolInteraction('call', { id: entry.call_id || entry.id, name: entry.name, arguments: parseStructuredValue(entry.arguments) || entry.arguments }, source)); }
                else if (entry.type === 'function_call_output') { pushIfPresent(buildToolInteraction('result', { id: entry.call_id || entry.id, name: 'function_call_output', output: entry.output }, source)); }
            });
        }
    }
    scanTopLevel(requestBody, 'request');
    scanTopLevel(responseBody, 'response');
    return interactions;
}

function renderToolInteractionPanels(interactions) {
    if (!Array.isArray(interactions) || interactions.length === 0) return '';
    const fileInteractions = interactions.filter(entry => entry.isFile);
    const otherInteractions = interactions.filter(entry => !entry.isFile);
    const ordered = [...fileInteractions, ...otherInteractions].slice(0, 20);
    return `<div class="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3"><p class="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 uppercase mb-2">📁 File Activity And Tool Output</p><div class="space-y-3">${ordered.map(renderToolInteractionCard).join('')}</div></div>`;
}

function renderToolInteractionCard(entry) {
    const pathLine = entry.paths.length > 0 ? `<p class="text-[10px] text-emerald-700 dark:text-emerald-300 font-mono break-all">${escapeHtml(entry.paths.join('\n'))}</p>` : '';
    const argsBlock = entry.argumentsText ? `<div><p class="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Input</p><pre class="text-[10px] bg-white dark:bg-slate-800 rounded p-2 overflow-x-auto text-slate-700 dark:text-slate-200">${escapeHtml(entry.argumentsText)}</pre></div>` : '';
    const outputBlock = entry.outputText ? `<div><p class="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Output</p><pre class="text-[10px] bg-white dark:bg-slate-800 rounded p-2 overflow-x-auto text-slate-700 dark:text-slate-200">${escapeHtml(entry.outputText)}</pre></div>` : '';
    return `<div class="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-white/70 dark:bg-slate-900 p-3 space-y-2"><div class="flex items-center justify-between gap-3"><div><p class="text-xs font-bold text-emerald-800 dark:text-emerald-200">${escapeHtml(entry.action)}: ${escapeHtml(entry.name)}</p><p class="text-[10px] text-slate-500 dark:text-slate-400 uppercase">${escapeHtml(entry.source)}${entry.kind === 'result' ? ' result' : ' call'}${entry.id ? ' • ' + escapeHtml(entry.id) : ''}</p></div></div>${pathLine}${argsBlock}${outputBlock}</div>`;
}

function extractResponsePanels(responseBody) {
    const parsed = parseStructuredValue(responseBody);
    if (!parsed) return [];
    const panels = [];
    if (Array.isArray(parsed.content)) {
        parsed.content.forEach(block => {
            if (!block || typeof block !== 'object') return;
            if (block.type === 'thinking' && block.thinking) { panels.push({ tone: 'indigo', title: 'Anthropic Thinking', content: block.thinking }); }
            else if (block.type === 'text' && block.text) { panels.push({ tone: 'slate', title: 'Response Content', content: block.text }); }
            else if (block.type === 'tool_use') { panels.push({ tone: 'orange', title: `Tool Use: ${block.name || 'unknown'}`, content: prettyJson(block.input || block) }); }
            else if (block.type === 'tool_result') { panels.push({ tone: 'amber', title: `Tool Result${block.tool_use_id ? ' (' + block.tool_use_id + ')' : ''}`, content: typeof block.content === 'string' ? block.content : prettyJson(block.content || block) }); }
        });
    }
    const choice = parsed.choices?.[0];
    const reasoningDetails = Array.isArray(choice?.message?.reasoning_details) ? choice.message.reasoning_details.filter(Boolean) : [];
    reasoningDetails.forEach((detail, index) => { const panel = formatReasoningDetail(detail, index); if (panel.content) panels.push(panel); });
    const openAIThinking = choice?.message?.reasoning || choice?.message?.reasoning_content || choice?.message?.thinking;
    const openAIContent = choice?.message?.content || '';
    if (openAIThinking) panels.push({ tone: 'indigo', title: 'Model Thinking', content: openAIThinking });
    if (openAIContent) panels.push({ tone: 'slate', title: 'Response Content', content: openAIContent });
    return panels;
}

function renderResponsePanel(panel) {
    const styles = { indigo: { box: 'bg-indigo-50 dark:bg-indigo-900/20', title: 'text-indigo-700 dark:text-indigo-300', body: 'text-indigo-900 dark:text-indigo-200' }, orange: { box: 'bg-orange-50 dark:bg-orange-900/20', title: 'text-orange-700 dark:text-orange-300', body: 'text-orange-900 dark:text-orange-200' }, amber: { box: 'bg-amber-50 dark:bg-amber-900/20', title: 'text-amber-700 dark:text-amber-300', body: 'text-amber-900 dark:text-amber-200' }, slate: { box: 'bg-slate-50 dark:bg-slate-900', title: 'text-slate-700 dark:text-slate-200', body: 'text-slate-800 dark:text-slate-100' } };
    const tone = styles[panel.tone] || styles.slate;
    return `<div class="${tone.box} rounded-lg p-3"><p class="text-[10px] font-bold ${tone.title} uppercase mb-1">${escapeHtml(panel.title)}</p><pre class="text-xs ${tone.body} whitespace-pre-wrap font-mono leading-relaxed">${escapeHtml(panel.content)}</pre></div>`;
}

/* ── Config UI ── */
function applyConfigToUI(cfg) {
    currentConfigState = JSON.parse(JSON.stringify(cfg || {}));
    if (cfg.claude) {
        document.getElementById('claudePublicModel').value = cfg.claude.currentModel || DEFAULT_CLAUDE_PUBLIC_ALIAS;
        setSelectValue('claudeModelSelect', cfg.claude._upstreamModel || cfg.claude.currentModel);
        document.getElementById('claudeTargetUrl').value = cfg.claude.targetUrl || '';
        document.getElementById('claudeApiKey').value = cfg.claude.apiKey || '';
        document.getElementById('claudeContextWindow').value = cfg.claude.contextWindow ? cfg.claude.contextWindow.toLocaleString() + ' tokens' : '';
        document.getElementById('overviewClaudeInCost').value = cfg.claude.inputCostPer1M || '';
        document.getElementById('overviewClaudeOutCost').value = cfg.claude.outputCostPer1M || '';
        document.getElementById('claudeStatusModel').innerText = cfg.claude.currentModel || '--';
        document.getElementById('claudeStatusAlias').innerText = 'Public alias: ' + (cfg.claude.currentModel || DEFAULT_CLAUDE_PUBLIC_ALIAS);
        document.getElementById('claudeStatusProvider').innerText = extractProvider(cfg.claude.targetUrl);
        document.getElementById('claudeStatusContext').innerText = cfg.claude.contextWindow ? formatTokenCount(cfg.claude.contextWindow) + ' ctx' : '--';
        document.getElementById('claudeOptimizationHint').innerText = getOptimizationSummary(cfg.claude, 'claude');
    }
    if (cfg.codex) {
        setSelectValue('codexModelSelect', cfg.codex.currentModel);
        document.getElementById('codexTargetUrl').value = cfg.codex.targetUrl || '';
        document.getElementById('codexApiKey').value = cfg.codex.apiKey || '';
        document.getElementById('codexContextWindow').value = cfg.codex.contextWindow ? cfg.codex.contextWindow.toLocaleString() + ' tokens' : '';
        document.getElementById('overviewCodexInCost').value = cfg.codex.inputCostPer1M || '';
        document.getElementById('overviewCodexOutCost').value = cfg.codex.outputCostPer1M || '';
        document.getElementById('codexStatusModel').innerText = cfg.codex.currentModel || '--';
        document.getElementById('codexStatusProvider').innerText = extractProvider(cfg.codex.targetUrl);
        document.getElementById('codexStatusContext').innerText = cfg.codex.contextWindow ? formatTokenCount(cfg.codex.contextWindow) + ' ctx' : '--';
        document.getElementById('codexOptimizationHint').innerText = getOptimizationSummary(cfg.codex, 'codex');
    }
    if (cfg.customProvider) {
        document.getElementById('customBaseUrl').value = cfg.customProvider.baseUrl || '';
        document.getElementById('customApiKey').value = cfg.customProvider.apiKey || '';
    }
    document.getElementById('requestLogLimit').value = cfg.requestLogLimit || DEFAULT_REQUEST_LOG_LIMIT;
    document.getElementById('pendingTimeoutMinutes').value = cfg.pendingRequestTimeoutMinutes || DEFAULT_PENDING_TIMEOUT_MINUTES;
    const memoryLimitInput = document.getElementById('memoryContextMaxChars');
    if (memoryLimitInput) memoryLimitInput.value = cfg.memoryContextMaxChars || DEFAULT_MEMORY_CONTEXT_MAX_CHARS;
    updateConfigDisplay(cfg);
    updateClineInfo();
    updateOverviewSummary(cfg);
    rerenderCostSummary();
    onClaudeAliasChange();
    if (cfg.claude && cfg.claude.currentModel) refreshContextWindow('claude');
    if (cfg.codex && cfg.codex.currentModel) refreshContextWindow('codex');
}

function setSelectValue(id, value) {
    const select = document.getElementById(id);
    if (!select || !value) return;
    let found = false;
    for (let i = 0; i < select.options.length; i++) { if (select.options[i].value === value) { found = true; break; } }
    if (found) { select.value = value; }
    else { const opt = document.createElement('option'); opt.value = value; opt.innerText = value; select.insertBefore(opt, select.firstChild); select.value = value; }
}

function maskSecretValue(value) {
    if (value === null || value === undefined || value === '') return value;
    const text = String(value);
    if (/^\$\{env:/i.test(text)) return text;
    if (text.length <= 10) return '***';
    return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function redactConfigForDisplay(value, keyName = '') {
    const sensitiveKey = /(api[-_]?key|token|secret|authorization|password|credential)/i.test(keyName);
    if (sensitiveKey) return maskSecretValue(value);
    if (Array.isArray(value)) return value.map(item => redactConfigForDisplay(item));
    if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactConfigForDisplay(child, key)])); }
    return value;
}

function updateConfigDisplay(cfg) {
    const safeCfg = redactConfigForDisplay(JSON.parse(JSON.stringify(cfg || {})));
    ['claude', 'codex'].forEach(profile => { if (!safeCfg[profile] || typeof safeCfg[profile] !== 'object') return; Object.keys(safeCfg[profile]).forEach(key => { if (key.startsWith('_') && key !== '_upstreamModel') delete safeCfg[profile][key]; }); });
    document.getElementById('currentConfig').innerText = JSON.stringify(safeCfg, null, 2);
}

function updateClineInfo() {
    document.getElementById('clineBaseUrl').value = 'http://localhost:8085';
    const overviewField = document.getElementById('overviewClineBaseUrl');
    if (overviewField) overviewField.value = 'http://localhost:8085';
}

function updateOverviewSummary(cfg) {
    const claudeModel = cfg?.claude?.currentModel || '--';
    const codexModel = cfg?.codex?.currentModel || '--';
    const claudeRoute = cfg?.claude?.targetUrl || '--';
    const codexRoute = cfg?.codex?.targetUrl || '--';
    const customBase = cfg?.customProvider?.baseUrl || '--';
    document.getElementById('sidebarClaudeModel').innerText = claudeModel;
    document.getElementById('sidebarCodexModel').innerText = codexModel;
    document.getElementById('overviewClaudeRoute').innerText = claudeRoute;
    document.getElementById('overviewClaudeBase').innerText = extractApiBaseUrl(claudeRoute);
    document.getElementById('overviewClaudeFeatures').innerText = getOptimizationSummary(cfg?.claude, 'claude');
    document.getElementById('overviewCodexRoute').innerText = codexRoute;
    document.getElementById('overviewCodexBase').innerText = extractApiBaseUrl(codexRoute);
    document.getElementById('overviewCodexFeatures').innerText = getOptimizationSummary(cfg?.codex, 'codex');
    document.getElementById('overviewCustomBase').innerText = customBase;
    syncProfileToOverview('claude');
    syncProfileToOverview('codex');
}

function syncSummaryFromUI() {
    document.getElementById('sidebarClaudeModel').innerText = document.getElementById('claudeStatusModel').innerText || '--';
    document.getElementById('sidebarCodexModel').innerText = document.getElementById('codexStatusModel').innerText || '--';
    const claudeRoute = document.getElementById('claudeTargetUrl').value || '--';
    const codexRoute = document.getElementById('codexTargetUrl').value || '--';
    const customBase = document.getElementById('customBaseUrl').value || '--';
    const liveClaude = getLiveProfileState('claude');
    const liveCodex = getLiveProfileState('codex');
    document.getElementById('overviewClaudeRoute').innerText = claudeRoute;
    document.getElementById('overviewClaudeBase').innerText = extractApiBaseUrl(claudeRoute);
    document.getElementById('overviewClaudeFeatures').innerText = getOptimizationSummary(liveClaude, 'claude');
    document.getElementById('overviewCodexRoute').innerText = codexRoute;
    document.getElementById('overviewCodexBase').innerText = extractApiBaseUrl(codexRoute);
    document.getElementById('overviewCodexFeatures').innerText = getOptimizationSummary(liveCodex, 'codex');
    document.getElementById('overviewCustomBase').innerText = customBase;
    const claudeHint = document.getElementById('claudeOptimizationHint');
    const codexHint = document.getElementById('codexOptimizationHint');
    if (claudeHint) claudeHint.innerText = getOptimizationSummary(liveClaude, 'claude');
    if (codexHint) codexHint.innerText = getOptimizationSummary(liveCodex, 'codex');
}

/* ── Dark Mode ── */
function initDarkMode() {
    const saved = localStorage.getItem('claudish-dark');
    const shouldBeDark = saved === 'true';
    const html = document.documentElement;
    if (shouldBeDark) { html.classList.add('dark'); document.getElementById('moonIcon').classList.add('hidden'); document.getElementById('sunIcon').classList.remove('hidden'); }
    else { html.classList.remove('dark'); document.getElementById('moonIcon').classList.remove('hidden'); document.getElementById('sunIcon').classList.add('hidden'); }
}
function toggleDarkMode() {
    const html = document.documentElement;
    const isDark = html.classList.toggle('dark');
    localStorage.setItem('claudish-dark', isDark);
    document.getElementById('moonIcon').classList.toggle('hidden');
    document.getElementById('sunIcon').classList.toggle('hidden');
}

/* ── Test Result Modal ── */
function showTestResult(title, content, isError) {
    const modal = document.getElementById('testResultModal');
    const titleEl = document.getElementById('testResultTitle');
    const bodyEl = document.getElementById('testResultBody');
    titleEl.innerText = title;
    titleEl.className = 'text-sm font-bold ' + (isError ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400');
    bodyEl.innerText = content;
    bodyEl.className = 'text-xs font-mono p-4 rounded-xl border whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto ' + (isError ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border-red-200 dark:border-red-800' : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800');
    modal.classList.remove('hidden');
}
function closeTestResult() { document.getElementById('testResultModal').classList.add('hidden'); }
function copyTestResult() {
    const text = document.getElementById('testResultBody').innerText;
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        const orig = btn.innerText;
        btn.innerText = '✅ Copied';
        setTimeout(() => btn.innerText = orig, 1500);
    });
}

/* ── Toast ── */
function showStatus(message, classes) {
    const toast = document.getElementById('statusToast');
    toast.className = 'fixed bottom-4 right-4 px-5 py-3 rounded-xl shadow-xl text-sm font-medium transition-all duration-300 z-50 ' + classes;
    toast.innerText = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(8px)'; }, 3000);
}

/* ── Markdown ── */
function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') { return escapeHtml(text); }
    marked.setOptions({ gfm: true, breaks: true });
    const raw = marked.parse(text);
    const clean = DOMPurify.sanitize(raw);
    return clean;
}

function highlightCodeBlocks(container) {
    if (typeof hljs === 'undefined') return;
    container.querySelectorAll('pre code[class*="language-"]').forEach(block => { hljs.highlightElement(block); });
}

function attachCopyButtons(container) {
    container.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = () => {
            const code = pre.querySelector('code');
            const text = code ? code.textContent : pre.textContent;
            navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000); }).catch(() => { btn.textContent = 'Failed'; });
        };
        pre.appendChild(btn);
    });
}

/* ── SSE ── */
function connectSSE() {
    console.log('[SSE] Connecting...');
    if (liveStream) { liveStream.close(); }
    const generation = ++liveStreamGeneration;
    const es = new EventSource('/ui/stream?' + getPeriodQueryString(currentPeriod));
    liveStream = es;
    es.onopen = function() { console.log('[SSE] Connected'); };
    es.onmessage = function(event) {
        if (generation !== liveStreamGeneration || liveStream !== es) return;
        try {
            const d = JSON.parse(event.data);
            if (d.stats) renderStats(d.stats);
            if (d.pending) renderPending(d.pending);
            if (d.completed) renderCompleted(d.completed);
            if (d.activity) renderActivity(d.activity);
            updateDebugStamp('requests', `SSE • ${(d.stats?.pendingRequests || 0)} pending`);
        } catch (e) { console.error('[SSE] render error:', e); }
    };
    es.onerror = function() {
        if (generation !== liveStreamGeneration) return;
        es.close();
        if (liveStream === es) { liveStream = null; }
        if (_sseRetryTimeout) clearTimeout(_sseRetryTimeout);
        _sseRetryTimeout = setTimeout(connectSSE, 3000);
        updateDebugStamp('requests', 'SSE reconnect scheduled');
    };
}
function reconnectSSE() {
    if (_sseRetryTimeout) { clearTimeout(_sseRetryTimeout); _sseRetryTimeout = null; }
    connectSSE();
}
