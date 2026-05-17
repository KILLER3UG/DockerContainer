/* ── AI Workbench (Claude Desktop 2026 + Codex CLI style) ── */

/* Helper: fill prompt from welcome chips */
function fillWorkbenchPrompt(text) {
    const input = document.getElementById('workbenchInput');
    if (input) { input.value = text; autoResizeTextarea(input); }
}

/* Remove welcome screen on first interaction */
function removeWelcome() {
    const w = document.getElementById('wbWelcome');
    if (w) w.remove();
}

/* ── Flat-Text Message Renderer ── */
function renderWorkbenchMessage(role, text, msgIndex) {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    removeWelcome();
    const isUser = role === 'user';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bodyHtml = isUser ? escapeHtml(text || '') : renderMarkdown(text || '');
    const contentClass = isUser ? 'whitespace-pre-wrap' : 'md-content';
    const idx = msgIndex != null ? msgIndex : Date.now();
    const roleLabel = isUser ? 'You' : '✦ August';
    const roleClass = isUser ? '' : 'is-assistant';
    const copyBtn = `<button onclick="copyMessage(this)" title="Copy"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg></button>`;
    const regenBtn = isUser ? '' : `<button onclick="regenerateMessage(this)" title="Regenerate"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></button>`;

    messages.insertAdjacentHTML('beforeend', `
        <div class="wb-msg ${isUser ? 'is-user' : 'is-assistant'}" data-msg-idx="${idx}">
            <div class="wb-msg-actions">${copyBtn}${regenBtn}</div>
            <div class="wb-msg-header">
                <span class="wb-msg-role ${roleClass}">${roleLabel}</span>
                <span class="wb-msg-time">${time}</span>
            </div>
            <div class="wb-msg-body">
                <div class="${contentClass}">${bodyHtml}</div>
            </div>
        </div>
    `);
    const last = messages.lastElementChild;
    if (last) {
        const body = last.querySelector('.wb-msg-body > .md-content');
        if (body) { highlightCodeBlocks(body); attachCopyButtons(body); }
    }
    messages.scrollTop = messages.scrollHeight;
}

function renderWorkbenchPlan() {
    const planEl = document.getElementById('workbenchPlan');
    const approveBtn = document.getElementById('workbenchApproveBtn');
    const badge = document.getElementById('workbenchGateBadge');
    if (!planEl || !approveBtn || !badge) return;
    const plan = workbenchSession?.plan;
    const approved = workbenchSession?.approved === true;
    approveBtn.disabled = !plan || approved;
    approveBtn.classList.toggle('opacity-50', !plan || approved);
    badge.textContent = approved ? 'Approved' : (plan ? 'Plan pending' : 'All tools ready');
    badge.className = approved
        ? 'rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
        : 'rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300';
    if (!plan) {
        planEl.innerHTML = '<p class="text-center py-3 opacity-60">No plan submitted yet</p>';
        const gateDiv = planEl.closest('.gate-panel');
        if (gateDiv) gateDiv.classList.remove('is-approved');
        return;
    }
    const gateDiv2 = planEl.closest('.gate-panel');
    if (gateDiv2) gateDiv2.classList.toggle('is-approved', approved);
    planEl.innerHTML = [
        plan.summary ? `<p class="mb-2">${renderMarkdown(plan.summary)}</p>` : '',
        Array.isArray(plan.steps) && plan.steps.length
            ? '<div class="text-[11px] font-bold uppercase tracking-wider opacity-60 mt-3 mb-1.5">Steps</div><ol class="list-decimal pl-4 space-y-1">' + plan.steps.map(s => `<li>${renderMarkdown(s)}</li>`).join('') + '</ol>'
            : '',
        Array.isArray(plan.files) && plan.files.length
            ? '<div class="text-[11px] font-bold uppercase tracking-wider opacity-60 mt-3 mb-1.5">Files</div><ul class="list-disc pl-4 space-y-0.5">' + plan.files.map(f => `<li><code>${escapeHtml(f)}</code></li>`).join('') + '</ul>'
            : '',
        Array.isArray(plan.risks) && plan.risks.length
            ? '<div class="text-[11px] font-bold uppercase tracking-wider opacity-60 mt-3 mb-1.5">Risks</div><ul class="list-disc pl-4 space-y-0.5">' + plan.risks.map(r => `<li>${escapeHtml(r)}</li>`).join('') + '</ul>'
            : '',
        Array.isArray(plan.verification) && plan.verification.length
            ? '<div class="text-[11px] font-bold uppercase tracking-wider opacity-60 mt-3 mb-1.5">Verification</div><ul class="list-disc pl-4 space-y-0.5">' + plan.verification.map(v => `<li>${escapeHtml(v)}</li>`).join('') + '</ul>'
            : '',
        `<div class="mt-3 pt-2 border-t border-dashed border-slate-300 dark:border-slate-700 text-[11px] ${approved ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'} font-semibold">${approved ? 'Approved — proxy system mutations unlocked' : 'Only proxy system writes are blocked'}</div>`
    ].filter(Boolean).join('\n');
}

async function ensureWorkbenchSession() {
    if (workbenchSession) {
        renderWorkbenchPlan();
        return workbenchSession;
    }
    const provider = document.getElementById('workbenchProvider')?.value || 'claude';
    const res = await fetch('/ui/workbench/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create Workbench session');
    workbenchSession = data;
    removeWelcome();
    renderWorkbenchPlan();
    setWorkbenchStatus('Ready', 'bg-emerald-400');
    return workbenchSession;
}

function setWorkbenchStatus(html, dotColor) {
    const inner = document.getElementById('workbenchStatusInner');
    if (!inner) return;
    inner.innerHTML = dotColor ? `<span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>${html}` : html;
}

function toggleWorkbenchDrawer() {
    const overlay = document.getElementById('wbDrawerOverlay');
    const drawer = document.getElementById('wbDrawer');
    if (!overlay || !drawer) return;
    const opening = !drawer.classList.contains('open');
    overlay.classList.toggle('open', opening);
    drawer.classList.toggle('open', opening);
}

function autoResizeTextarea(el) {
    const sendBtn = document.getElementById('workbenchSendBtn');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    if (sendBtn) sendBtn.disabled = !el.value.trim();
}

function copyMessage(btn) {
    const msg = btn.closest('.wb-msg');
    if (!msg) return;
    const body = msg.querySelector('.wb-msg-body > div');
    const text = body ? body.textContent : '';
    navigator.clipboard.writeText(text).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
        setTimeout(() => btn.innerHTML = orig, 1500);
    });
}

function regenerateMessage(btn) {
    const msg = btn.closest('.wb-msg');
    if (!msg) return;
    sendWorkbenchMessageUI();
}

function showTypingIndicator() {
    const inner = document.getElementById('workbenchStatusInner');
    if (!inner) return;
    inner.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
}

/* ── Thinking with Spinner + Timer (Claude-style) ── */
let thinkContainer = null;
let thinkStartTime = null;
let thinkTimerInterval = null;

function ensureThinkContainer() {
    if (thinkContainer && thinkContainer.isConnected) return true;
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return false;
    removeWelcome();
    thinkStartTime = Date.now();
    const div = document.createElement('div');
    div.className = 'think-container';
    div.innerHTML = '<div class="think-toggle"><span class="think-spinner"></span><span class="think-label">Thinking\u2026 <span class="think-timer">0.0s</span></span><span class="think-arrow">\u25B6</span></div><div class="think-body"></div>';
    div.querySelector('.think-toggle').onclick = function () { this.parentElement.classList.toggle('think-open'); };
    messages.appendChild(div);
    thinkContainer = div;
    // Start timer
    const timerEl = div.querySelector('.think-timer');
    thinkTimerInterval = setInterval(() => {
        if (timerEl && thinkStartTime) {
            timerEl.textContent = ((Date.now() - thinkStartTime) / 1000).toFixed(1) + 's';
        }
    }, 100);
    messages.scrollTop = messages.scrollHeight;
    return true;
}

function renderThinkingDelta(text) {
    if (!ensureThinkContainer()) return;
    const body = thinkContainer.querySelector('.think-body');
    body.textContent += text;
}

function resetThinkLine() {
    if (thinkTimerInterval) { clearInterval(thinkTimerInterval); thinkTimerInterval = null; }
    if (thinkContainer && thinkContainer.isConnected) {
        // Replace spinner with done icon, finalize timer
        const spinner = thinkContainer.querySelector('.think-spinner');
        if (spinner) { spinner.outerHTML = '<span class="think-done-icon">\u25C9</span>'; }
        const label = thinkContainer.querySelector('.think-label');
        if (label && thinkStartTime) {
            const elapsed = ((Date.now() - thinkStartTime) / 1000).toFixed(1);
            label.textContent = `Thought for ${elapsed}s`;
        }
    }
    thinkContainer = null;
    thinkStartTime = null;
}

/* ── Tool Lines (Codex-style accent blocks) ── */
function renderToolLine(id, name, input) {
    resetThinkLine();
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    removeWelcome();
    const inputSummary = typeof input === 'string' ? input : (input && typeof input === 'object' ? (input.path || input.command || input.query || JSON.stringify(input).slice(0, 80)) : '');
    const div = document.createElement('div');
    div.className = 'tool-line';
    div.dataset.tid = id;
    div.innerHTML = `<div class="tool-line-header"><span class="tool-icon">\u26A1</span><span class="tool-name">${escapeHtml(name)}</span><span class="tool-status running"><span class="tool-status-dot running"></span>running\u2026</span></div>${inputSummary ? `<div class="tool-input-summary">${escapeHtml(inputSummary)}</div>` : ''}`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function updateToolLine(id, content, isError) {
    const el = document.querySelector('.tool-line[data-tid="' + id.replace(/"/g, '\\"') + '"]');
    if (!el) return;
    const status = el.querySelector('.tool-status');
    const dot = el.querySelector('.tool-status-dot');
    if (isError) {
        el.classList.add('is-error');
        if (status) { status.className = 'tool-status error'; status.innerHTML = '<span class="tool-status-dot"></span>\u2717 error'; }
    } else {
        el.classList.add('is-done');
        if (status) { status.className = 'tool-status done'; status.innerHTML = '<span class="tool-status-dot"></span>\u2713 done'; }
    }
    if (dot) dot.classList.remove('running');
}

/* ── SSE Event Handler ── */
function handleSSEEvent(event, data) {
    switch (event) {
        case 'thinking': renderThinkingDelta(data.content); break;
        case 'tool_use': renderToolLine(data.id, data.name, data.input); break;
        case 'tool_result': updateToolLine(data.id, data.content, data.is_error); break;
        case 'text':
            resetThinkLine();
            renderWorkbenchMessage('assistant', data.content);
            break;
        case 'session':
            workbenchSession = data;
            renderWorkbenchPlan();
            if (workbenchSession.approved) setWorkbenchStatus('Plan approved', 'bg-emerald-400');
            else if (workbenchSession.plan) setWorkbenchStatus('Plan pending', 'bg-amber-400');
            else setWorkbenchStatus('Ready', 'bg-emerald-400');
            break;
        case 'error':
            resetThinkLine();
            renderWorkbenchMessage('assistant', 'Error: ' + data.message);
            setWorkbenchStatus('Error.', 'bg-red-400');
            break;
        case 'done': break;
    }
}

async function readSSEStream(reader) {
    const dec = new TextDecoder();
    let buf = '', evt = '', dat = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() || '';
        for (const line of parts) {
            if (line.startsWith('event: ')) evt = line.slice(7).trim();
            else if (line.startsWith('data: ')) dat = line.slice(6).trim();
            else if (line === '' && evt && dat) {
                try { handleSSEEvent(evt, JSON.parse(dat)); } catch (e) {}
                evt = ''; dat = '';
            }
        }
    }
    if (evt && dat) { try { handleSSEEvent(evt, JSON.parse(dat)); } catch (e) {} }
}

async function sendWorkbenchMessageUI() {
    const input = document.getElementById('workbenchInput');
    const sendBtn = document.getElementById('workbenchSendBtn');
    const message = input?.value.trim();
    if (!message) return;
    await ensureWorkbenchSession();
    input.value = '';
    input.style.height = 'auto';
    if (sendBtn) sendBtn.disabled = true;
    renderWorkbenchMessage('user', message);
    setWorkbenchStatus('Working\u2026', 'bg-amber-400');
    lastThinkLine = null;
    try {
        const res = await fetch('/ui/workbench/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                sessionId: workbenchSession.id,
                provider: document.getElementById('workbenchProvider')?.value || 'claude',
                message
            })
        });
        if (!res.ok) {
            const errText = await res.text();
            let errMsg = 'Workbench request failed';
            try { errMsg = JSON.parse(errText).error || errMsg; } catch (e) { errMsg = errText || errMsg; }
            throw new Error(errMsg);
        }
        await readSSEStream(res.body.getReader());
        renderWorkbenchPlan();
    } catch (e) {
        resetThinkLine();
        renderWorkbenchMessage('assistant', e.message);
        setWorkbenchStatus('Error.', 'bg-red-400');
    } finally {
        if (sendBtn) sendBtn.disabled = false;
    }
}

async function approveWorkbenchPlanUI() {
    await ensureWorkbenchSession();
    try {
        const res = await fetch('/ui/workbench/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: workbenchSession.id })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not approve plan');
        workbenchSession = data;
        renderWorkbenchPlan();
        renderWorkbenchMessage('assistant', 'Plan approved. Proxy system mutations are now unlocked. Send a follow-up message such as "implement the approved plan" to let the agent proceed.');
        showStatus('Workbench plan approved', 'bg-emerald-600 text-white');
    } catch (e) { showStatus(e.message, 'bg-red-600 text-white'); }
}

async function resetWorkbenchUI() {
    const previousId = workbenchSession?.id;
    const provider = document.getElementById('workbenchProvider')?.value || 'claude';
    const res = await fetch('/ui/workbench/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: previousId, provider })
    });
    const data = await res.json();
    if (!res.ok) { showStatus(data.error || 'Could not reset Workbench', 'bg-red-600 text-white'); return; }
    workbenchSession = data;
    const messages = document.getElementById('workbenchMessages');
    if (messages) {
        messages.innerHTML = `<div class="wb-welcome" id="wbWelcome">
            <div class="wb-welcome-icon">&#10022;</div>
            <div class="wb-welcome-title">August AI</div>
            <div class="wb-welcome-desc">New session started. Full system access &mdash; read, write, execute, search, and control.</div>
            <div class="wb-welcome-chips">
                <button class="wb-welcome-chip" onclick="fillWorkbenchPrompt('Refactor the auth module')">Refactor code</button>
                <button class="wb-welcome-chip" onclick="fillWorkbenchPrompt('Debug why tests are failing')">Debug tests</button>
                <button class="wb-welcome-chip" onclick="fillWorkbenchPrompt('Search the web for latest best practices')">Web search</button>
            </div>
        </div>`;
    }
    renderWorkbenchPlan();
    setWorkbenchStatus('Ready', 'bg-emerald-400');
    showStatus('Workbench session reset', 'bg-slate-700 text-white');
}

async function loadComputerUseStatus() {
    const badge = document.getElementById('computerUseStatus');
    if (!badge) return;
    try {
        const res = await fetch('/ui/host-agent/status', { cache: 'no-store' });
        const data = await res.json();
        if (data.status === 'connected') {
            badge.textContent = 'connected';
            badge.className = 'ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
        } else {
            badge.textContent = 'offline';
            badge.className = 'ml-auto rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300';
        }
    } catch (e) {
        badge.textContent = 'offline';
        badge.className = 'ml-auto rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300';
    }
}

async function importCapabilityLinkUI() {
    const url = document.getElementById('importCapabilityUrl').value.trim();
    const enableMcp = document.getElementById('importEnableMcp').checked;
    const resultEl = document.getElementById('importCapabilityResult');
    if (!url) { showStatus('Paste a capability link first', 'bg-red-600 text-white'); return; }
    resultEl.classList.remove('hidden');
    resultEl.textContent = 'Importing...';
    try {
        const res = await fetch('/ui/import-link', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, enableMcp })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        const imported = data.imported || {};
        resultEl.textContent = [
            `Resolved: ${imported.resolvedUrl || url}`,
            `Plugins: ${(imported.plugins || []).map(item => item.name).join(', ') || 'none'}`,
            `Skills: ${(imported.skills || []).map(item => item.name).join(', ') || 'none'}`,
            `MCP servers: ${(imported.mcpServers || []).map(item => `${item.name}${item.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`
        ].join('\n');
        showStatus('Capability link imported', 'bg-emerald-600 text-white');
        await Promise.all([loadMcpUI(), loadSkillsUI(), loadPluginsUI(), loadCompatibilityUI(), loadMemoryPreview(), loadHealthUI()]);
    } catch (e) { resultEl.textContent = e.message; showStatus(e.message, 'bg-red-600 text-white'); }
}
