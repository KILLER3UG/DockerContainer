/* ── AI Workbench ── */
function renderWorkbenchMessage(role, text, msgIndex) {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    const isUser = role === 'user';
    const bubbleClass = isUser ? 'is-user' : 'is-assistant';
    const label = isUser ? 'You' : 'Workbench';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bodyHtml = isUser ? escapeHtml(text || '') : renderMarkdown(text || '');
    const contentClass = isUser ? 'whitespace-pre-wrap' : 'md-content';
    const idx = msgIndex != null ? msgIndex : Date.now();
    messages.insertAdjacentHTML('beforeend', `
        <div class="chat-bubble ${bubbleClass}" data-msg-idx="${idx}">
            <div class="msg-actions">
                <button onclick="copyMessage(this)" title="Copy">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                </button>
                ${isUser ? '' : `<button onclick="regenerateMessage(this)" title="Regenerate">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                </button>`}
            </div>
            <div class="bubble-label">${label}</div>
            <div class="chat-body">
                <div class="${contentClass}">${bodyHtml}</div>
                <div class="bubble-time">${time}</div>
            </div>
        </div>
    `);
    const last = messages.lastElementChild;
    if (last) {
        const body = last.querySelector('.chat-body > .md-content');
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
    const wbMsgs = document.getElementById('workbenchMessages');
    if (wbMsgs && wbMsgs.children.length === 0) {
        wbMsgs.innerHTML = '<div class="chat-bubble is-assistant"><div class="bubble-label">Workbench</div><div class="chat-body"><div>The AI Workbench has full system access — it can read, write, execute commands, use MCP tools, search the web, and control your desktop. Only modifications to the proxy\'s own files require an explicit approved plan.</div></div></div>';
    }
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
    const bubble = btn.closest('.chat-bubble');
    if (!bubble) return;
    const body = bubble.querySelector('.chat-body > div:not(.bubble-time)');
    const text = body ? body.textContent : '';
    navigator.clipboard.writeText(text).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
        setTimeout(() => btn.innerHTML = orig, 1500);
    });
}

function regenerateMessage(btn) {
    const bubble = btn.closest('.chat-bubble');
    if (!bubble) return;
    sendWorkbenchMessageUI();
}

function showTypingIndicator() {
    const inner = document.getElementById('workbenchStatusInner');
    if (!inner) return;
    inner.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
}

/* ── Content Block Renderers ── */
function renderThinkingBlock(thinking) {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messages.insertAdjacentHTML('beforeend', `
        <div class="wb-thinking-block">
            <button class="wb-thinking-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
                <svg class="wb-thinking-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
                <span>Thinking</span>
                <span class="wb-thinking-time">${time}</span>
            </button>
            <div class="wb-thinking-body">${escapeHtml(thinking)}</div>
        </div>
    `);
    messages.scrollTop = messages.scrollHeight;
}

function renderToolCallBlock(name, input, id) {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const inputStr = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input || '');
    messages.insertAdjacentHTML('beforeend', `
        <div class="wb-tool-block" data-tool-id="${escapeHtml(id || '')}">
            <div class="wb-tool-header">
                <svg class="wb-tool-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                <span class="wb-tool-name">${escapeHtml(name)}</span>
                <span class="wb-tool-time">${time}</span>
                <span class="wb-tool-status wb-tool-pending">running...</span>
            </div>
            <div class="wb-tool-args"><pre>${escapeHtml(inputStr)}</pre></div>
        </div>
    `);
    messages.scrollTop = messages.scrollHeight;
}

function updateToolResult(id, content, isError) {
    const block = document.querySelector(`.wb-tool-block[data-tool-id="${escapeHtml(id)}"]`);
    if (!block) return;
    const statusEl = block.querySelector('.wb-tool-status');
    if (statusEl) {
        statusEl.textContent = isError ? 'error' : 'done';
        statusEl.className = 'wb-tool-status ' + (isError ? 'wb-tool-error' : 'wb-tool-done');
    }
    const argsEl = block.querySelector('.wb-tool-args');
    if (argsEl && content) {
        let display = content;
        try { const parsed = JSON.parse(content); display = JSON.stringify(parsed, null, 2); } catch (e) {}
        argsEl.insertAdjacentHTML('beforeend', `<div class="wb-tool-result ${isError ? 'wb-tool-result-error' : ''}"><strong>result:</strong><pre>${escapeHtml(display)}</pre></div>`);
    }
}

function renderSubagentBlock(task, result) {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messages.insertAdjacentHTML('beforeend', `
        <div class="wb-subagent-block">
            <div class="wb-subagent-header">
                <svg class="wb-subagent-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/></svg>
                <span class="wb-subagent-label">Sub-agent</span>
                <span class="wb-tool-time">${time}</span>
            </div>
            <div class="wb-subagent-task"><strong>Task:</strong> ${escapeHtml(task)}</div>
            <div class="wb-subagent-result"><strong>Result:</strong><pre>${escapeHtml(result || '(no output)')}</pre></div>
        </div>
    `);
    messages.scrollTop = messages.scrollHeight;
}

function renderAssistantEvents(events) {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let textBuffer = '';
    const flushText = () => {
        if (!textBuffer) return;
        messages.insertAdjacentHTML('beforeend', `
            <div class="chat-bubble is-assistant">
                <div class="msg-actions">
                    <button onclick="copyMessage(this)" title="Copy">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                    </button>
                    <button onclick="regenerateMessage(this)" title="Regenerate">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                    </button>
                </div>
                <div class="bubble-label">Workbench</div>
                <div class="chat-body">
                    <div class="md-content">${renderMarkdown(textBuffer)}</div>
                    <div class="bubble-time">${time}</div>
                </div>
            </div>
        `);
        const last = messages.lastElementChild;
        if (last) { const body = last.querySelector('.chat-body > .md-content'); if (body) { highlightCodeBlocks(body); attachCopyButtons(body); } }
        textBuffer = '';
    };
    for (const evt of events) {
        if (evt.type === 'text') { textBuffer += (textBuffer ? '\n\n' : '') + evt.content; }
        else if (evt.type === 'thinking') { flushText(); renderThinkingBlock(evt.content); }
        else if (evt.type === 'tool_use') { flushText(); renderToolCallBlock(evt.name, evt.input, evt.id); }
        else if (evt.type === 'tool_result') { updateToolResult(evt.id, evt.content, evt.is_error); }
        else if (evt.type === 'subagent') { flushText(); renderSubagentBlock(evt.task, evt.result); }
    }
    flushText();
    messages.scrollTop = messages.scrollHeight;
}

function renderContentBlocks(content) {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    const textParts = content.filter(b => b.type === 'text').map(b => b.text || '');
    const thinkingParts = content.filter(b => b.type === 'thinking');
    const toolUses = content.filter(b => b.type === 'tool_use');
    const text = textParts.join('\n\n');
    if (text) renderWorkbenchMessage('assistant', text);
    thinkingParts.forEach(b => renderThinkingBlock(b.thinking));
    toolUses.forEach(b => renderToolCallBlock(b.name, b.input, b.id));
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
    showTypingIndicator();
    try {
        const res = await fetch('/ui/workbench/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                sessionId: workbenchSession.id,
                provider: document.getElementById('workbenchProvider')?.value || 'claude',
                message
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Workbench request failed');
        workbenchSession = data.session || workbenchSession;
        if (data.events && data.events.length > 0) {
            renderAssistantEvents(data.events);
        } else if (data.content && data.content.length > 0) {
            renderContentBlocks(data.content);
        } else {
            renderWorkbenchMessage('assistant', data.assistant || '(no text response)');
        }
        renderWorkbenchPlan();
        if (workbenchSession.approved) setWorkbenchStatus('Plan approved', 'bg-emerald-400');
        else if (workbenchSession.plan) setWorkbenchStatus('Plan pending', 'bg-amber-400');
        else setWorkbenchStatus('Ready', 'bg-emerald-400');
    } catch (e) {
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
        messages.innerHTML = '<div class="chat-bubble is-assistant"><div class="bubble-label">Workbench</div><div class="chat-body"><div>New session started. All tools available — read/write/execute anywhere on the system. Proxy system modifications require an approved plan. Use workbench_submit_plan to request approval for proxy modifications.</div></div></div>';
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
