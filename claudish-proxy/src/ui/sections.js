/* ── Memory ── */

        function escMemHtml(str) {
            if (!str) return '';
            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        async function loadMemoryUI() {
            try {
                const res = await fetch('/ui/memory');
                const memory = await res.json();
                document.getElementById('memoryUserProfile').value = memory.user_profile || '';
                document.getElementById('memoryGlobalContext').value = memory.global_context || '';

                // Active Projects
                const projectsEl = document.getElementById('memoryProjects');
                const projects = Array.isArray(memory.active_projects) ? memory.active_projects : [];
                document.getElementById('memoryProjectCount').textContent = projects.length;
                if (projects.length === 0) {
                    projectsEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 italic">No projects tracked yet</p>';
                } else {
                    projectsEl.innerHTML = projects.map(p => {
                        const statusBadge = p.status ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300">${escMemHtml(p.status)}</span>` : '';
                        const summary = p.summary ? `<p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${escMemHtml(p.summary)}</p>` : '';
                        const date = p.updated_at ? `<p class="mt-1 text-[9px] text-slate-400 dark:text-slate-500">${new Date(p.updated_at).toLocaleString()}</p>` : '';
                        return `<div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2"><div class="flex items-center justify-between"><span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(p.name || 'Untitled')}</span>${statusBadge}</div>${summary}${date}</div>`;
                    }).join('');
                }

                // Integrations
                const intEl = document.getElementById('memoryIntegrations');
                const integrations = memory.integrations && typeof memory.integrations === 'object' ? Object.entries(memory.integrations) : [];
                document.getElementById('memoryIntegrationCount').textContent = integrations.length;
                if (integrations.length === 0) {
                    intEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 italic">No integrations recorded</p>';
                } else {
                    intEl.innerHTML = integrations.map(([name, d]) => {
                        const statusBadge = d?.status ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">${escMemHtml(d.status)}</span>` : '';
                        const summary = d?.summary ? `<p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${escMemHtml(d.summary)}</p>` : '';
                        return `<div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2"><div class="flex items-center justify-between"><span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(name)}</span>${statusBadge}</div>${summary}</div>`;
                    }).join('');
                }

                // Recent Events
                const evEl = document.getElementById('memoryEvents');
                const events = Array.isArray(memory.recent_events) ? memory.recent_events : [];
                document.getElementById('memoryEventCount').textContent = events.length;
                if (events.length === 0) {
                    evEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 italic">No events recorded</p>';
                } else {
                    evEl.innerHTML = events.slice().reverse().map(ev => {
                        const ts = ev.timestamp ? `<span class="text-[9px] text-slate-400 dark:text-slate-500">${new Date(ev.timestamp).toLocaleString()}</span>` : '';
                        const src = ev.source ? `<span class="text-[9px] text-slate-400 dark:text-slate-500">via ${escMemHtml(ev.source)}</span>` : '';
                        return `<div class="flex gap-3 items-start py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0"><span class="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600"></span><div class="min-w-0"><p class="text-[11px] text-slate-600 dark:text-slate-300">${escMemHtml(ev.summary || '')}</p><div class="flex gap-2 mt-0.5">${ts}${src}</div></div></div>`;
                    }).join('');
                }

                // Conversation Checkpoints
                const cpEl = document.getElementById('memoryCheckpoints');
                const checkpoints = Array.isArray(memory.conversation_checkpoints) ? memory.conversation_checkpoints : [];
                document.getElementById('memoryCheckpointCount').textContent = checkpoints.length;
                if (checkpoints.length === 0) {
                    cpEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 italic">No checkpoints saved</p>';
                } else {
                    cpEl.innerHTML = checkpoints.slice().reverse().map(cp => {
                        const topic = cp.topic ? `<span class="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase">${escMemHtml(cp.topic)}</span>` : '';
                        const ts = cp.timestamp ? `<p class="mt-1 text-[9px] text-slate-400 dark:text-slate-500">${new Date(cp.timestamp).toLocaleString()}</p>` : '';
                        return `<div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">${topic}<p class="text-[11px] text-slate-600 dark:text-slate-300 ${cp.topic ? 'mt-1' : ''}">${escMemHtml(cp.summary || '')}</p>${ts}</div>`;
                    }).join('');
                }

                document.getElementById('memoryLastSync').textContent = 'Last synced: ' + new Date().toLocaleTimeString();
                await Promise.all([loadMemoryPreview(), loadMemoryItemsUI()]);
            } catch (e) {
                const syncEl = document.getElementById('memoryLastSync');
                if (syncEl) syncEl.textContent = 'Memory refresh delayed; retrying on the next poll.';
            }
        }

        async function loadMemoryItemsUI() {
            const list = document.getElementById('memoryLifecycleList');
            if (!list) return;
            try {
                const res = await fetch('/ui/memory/items', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load memory lifecycle');
                memoryItemState = Array.isArray(data.items) ? data.items : [];
                renderMemoryItemsUI();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function memoryLifecycleClass(status) {
            if (status === 'active') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
            if (status === 'stale') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
            return 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
        }

        function renderMemoryItemsUI() {
            const list = document.getElementById('memoryLifecycleList');
            if (!list) return;
            if (memoryItemState.length === 0) {
                list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No August Brain items available yet.</div>';
                return;
            }

            list.innerHTML = memoryItemState.slice(0, 16).map(item => {
                const key = encodeURIComponent(item.key || '');
                const type = encodeURIComponent(item.type || '');
                const confidence = Math.round(Number(item.confidence || 0) * 100);
                const score = Number(item.injection?.score || 0);
                const nextStatus = item.status === 'archived' ? 'active' : 'archived';
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-wrap items-center gap-2">
                            <h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100" title="${escapeHtml(item.title)}">${escapeHtml(item.title || 'Memory item')}</h3>
                            ${renderTinyBadge(item.pinned ? 'pinned' : 'unpinned', item.pinned ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                            ${renderTinyBadge(item.status || 'active', memoryLifecycleClass(item.status || 'active'))}
                        </div>
                        <p class="mt-2 line-clamp-3 text-xs leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(item.summary || '')}</p>
                        <div class="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                            <span>Score ${score}</span>
                            <span>Confidence ${confidence}%</span>
                        </div>
                        <p class="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600 dark:bg-slate-950 dark:text-slate-300">${escapeHtml(item.injection?.reason || '')}</p>
                        <div class="mt-3 flex flex-wrap gap-2">
                            <button onclick="updateMemoryItemUI('${type}', '${key}', { pinned: ${item.pinned ? 'false' : 'true'} })" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">${item.pinned ? 'Unpin' : 'Pin'}</button>
                            <button onclick="updateMemoryItemUI('${type}', '${key}', { status: '${nextStatus}' })" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">${item.status === 'archived' ? 'Activate' : 'Archive'}</button>
                            <button onclick="updateMemoryItemUI('${type}', '${key}', { status: 'stale' })" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">Mark Stale</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function updateMemoryItemUI(type, key, updates) {
            try {
                const res = await fetch('/ui/memory/items', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: decodeURIComponent(type),
                        key: decodeURIComponent(key),
                        updates
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update memory item');
                memoryItemState = Array.isArray(data.items) ? data.items : memoryItemState;
                renderMemoryItemsUI();
                await Promise.all([loadMemoryPreview(), loadHealthUI()]);
                showStatus('Memory lifecycle updated', 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function searchMemoryUI() {
            const input = document.getElementById('memorySearchQuery');
            const results = document.getElementById('memorySearchResults');
            if (!input || !results) return;
            const query = input.value.trim();
            if (!query) {
                results.textContent = 'Search August Brain and local vector memory.';
                return;
            }
            results.textContent = 'Searching...';
            try {
                const res = await fetch('/ui/memory/search?q=' + encodeURIComponent(query), { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Search failed');
                const core = Array.isArray(data.core) ? data.core : [];
                const vector = Array.isArray(data.vector) ? data.vector : [];
                const coreHtml = core.length
                    ? core.map(item => `<div class="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"><p class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(item.title)}</p><p class="mt-1 leading-5">${escapeHtml(item.summary || '')}</p></div>`).join('')
                    : '<p class="text-slate-400 dark:text-slate-500">No core matches.</p>';
                const vectorHtml = vector.length
                    ? vector.map(item => `<div class="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"><p class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(item.topic || 'Vector memory')}</p><p class="mt-1 leading-5">${escapeHtml(item.summary || '')}</p></div>`).join('')
                    : '<p class="text-slate-400 dark:text-slate-500">No vector matches.</p>';
                results.innerHTML = `
                    <div class="space-y-3">
                        <div>
                            <h3 class="text-[11px] font-bold uppercase text-slate-500 dark:text-slate-400">August Brain</h3>
                            <div class="mt-2 space-y-2">${coreHtml}</div>
                        </div>
                        <div>
                            <h3 class="text-[11px] font-bold uppercase text-slate-500 dark:text-slate-400">Vector Memory</h3>
                            <div class="mt-2 space-y-2">${vectorHtml}</div>
                            <p class="mt-2 text-[11px] text-slate-400 dark:text-slate-500">${Number(data.vectorCount || 0)} vector entries indexed</p>
                        </div>
                    </div>
                `;
            } catch (e) {
                results.innerHTML = `<div class="rounded-xl border border-red-200 bg-red-50 p-3 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function refreshMemoryUI() {
            loadMemoryUI();
            showStatus('Memory refreshed', 'bg-slate-700 text-white');
        }

        async function saveMemoryUI() {
            try {
                const user_profile = document.getElementById('memoryUserProfile').value;
                const global_context = document.getElementById('memoryGlobalContext').value;
                const res = await fetch('/ui/memory', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_profile, global_context })
                });
                if (res.ok) {
                    showStatus('Memory saved successfully!', 'bg-emerald-600 text-white');
                    await loadMemoryUI();
                } else {
                    showStatus('Failed to save memory', 'bg-red-600 text-white');
                }
            } catch (e) {
                showStatus('Network error saving memory', 'bg-red-600 text-white');
            }
        }

        function parseLinesOrJsonArray(value) {
            const text = String(value || '').trim();
            if (!text) return [];
            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) return parsed.map(item => String(item)).filter(Boolean);
            } catch (e) {
                // Newline mode is friendlier for quick dashboard edits.
            }
            return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        }

        function parseEnvText(value) {
            const text = String(value || '').trim();
            if (!text) return {};
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            } catch (e) {
                // Fall back to KEY=VALUE lines.
            }
            return Object.fromEntries(
                text.split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(Boolean)
                    .map(line => {
                        const idx = line.indexOf('=');
                        return idx === -1
                            ? [line, '']
                            : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
                    })
                    .filter(([key]) => key)
            );
        }

/* ── Compatibility ── */
        async function loadCompatibilityUI() {
            const list = document.getElementById('compatibilityList');
            if (!list) return;
            try {
                const res = await fetch('/ui/compatibility', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                compatibilityState = await res.json();
                renderCompatibilityUI();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function renderCompatibilityUI() {
            const list = document.getElementById('compatibilityList');
            const host = document.getElementById('hostFilesInfo');
            if (!compatibilityState) return;
            const families = Array.isArray(compatibilityState.families) ? compatibilityState.families : [];
            list.innerHTML = families.map(family => {
                const tools = Array.isArray(family.tools) ? family.tools : [];
                const statusClass = family.status === 'available'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : family.status === 'degraded'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-wrap items-center gap-2">
                            <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(family.name)}</h3>
                            ${renderTinyBadge(family.status || 'unknown', statusClass)}
                            ${renderTinyBadge(family.mode || 'local', 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300')}
                        </div>
                        <p class="mt-2 max-h-28 overflow-auto font-mono text-[10px] leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(tools.slice(0, 14).map(tool => tool.name).join('\n') || 'No tools listed')}</p>
                    </div>
                `;
            }).join('');
            if (host && compatibilityState.hostFiles) {
                const folders = compatibilityState.hostFiles.folders || [];
                host.textContent = [
                    `Host: ${compatibilityState.hostFiles.hostPath}`,
                    `Container: ${compatibilityState.hostFiles.containerPath}`,
                    `Folders: ${folders.map(folder => folder.name).join(', ') || 'none yet'}`,
                    compatibilityState.claudeDesktopPluginRestriction?.message || ''
                ].filter(Boolean).join('\n');
            }
        }

        async function createHostFilesFolderUI() {
            const name = document.getElementById('hostFolderName').value.trim() || 'dropzone';
            try {
                const res = await fetch('/ui/host-files/folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not create host_files folder');
                compatibilityState = data.compatibility;
                renderCompatibilityUI();
                showStatus(`Created ${data.folder.name}`, 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── Plugins ── */
        async function loadPluginsUI() {
            const list = document.getElementById('pluginList');
            if (!list) return;
            try {
                const res = await fetch('/ui/plugins', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                pluginListState = Array.isArray(data.plugins) ? data.plugins : [];
                renderPluginsUI();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function renderPluginsUI() {
            const list = document.getElementById('pluginList');
            if (!list) return;
            if (pluginListState.length === 0) {
                list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No proxy plugins imported yet.</div>';
                return;
            }
            list.innerHTML = pluginListState.map(plugin => {
                const skillCount = Array.isArray(plugin.skills) ? plugin.skills.length : 0;
                const mcpCount = Array.isArray(plugin.mcpServers) ? plugin.mcpServers.length : 0;
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(plugin.name)}</h3>
                                    ${renderTinyBadge(plugin.enabled === false ? 'disabled' : 'enabled', plugin.enabled === false ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300')}
                                </div>
                                <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(plugin.description || 'Imported proxy plugin')}</p>
                                <p class="mt-2 break-all font-mono text-[10px] text-slate-400 dark:text-slate-500">${escapeHtml(plugin.sourceUrl || '')}</p>
                                <p class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">${skillCount} skills, ${mcpCount} MCP servers</p>
                            </div>
                            <div class="flex shrink-0 flex-col gap-2">
                                <button onclick="togglePluginUI('${plugin.name}', ${plugin.enabled === false ? 'true' : 'false'})" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">${plugin.enabled === false ? 'Enable' : 'Disable'}</button>
                                <button onclick="refreshPluginUI('${plugin.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">Update</button>
                                <button onclick="deletePluginUI('${plugin.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function togglePluginUI(name, enabled) {
            try {
                const res = await fetch('/ui/plugins/' + encodeURIComponent(name), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update plugin');
                pluginListState = Array.isArray(data.plugins) ? data.plugins : [];
                renderPluginsUI();
                await Promise.all([loadMemoryPreview(), loadHealthUI()]);
                showStatus(enabled ? 'Proxy plugin enabled' : 'Proxy plugin disabled', 'bg-slate-700 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function refreshPluginUI(name) {
            try {
                const res = await fetch('/ui/plugins/' + encodeURIComponent(name) + '/refresh', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update plugin');
                pluginListState = Array.isArray(data.plugins) ? data.plugins : [];
                renderPluginsUI();
                await Promise.all([loadMcpUI(), loadSkillsUI(), loadMemoryPreview(), loadHealthUI()]);
                showStatus('Proxy plugin refreshed from source', 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deletePluginUI(name) {
            if (!confirm(`Delete proxy plugin ${name}? Imported skills/MCP server configs remain until deleted from their own sections.`)) return;
            try {
                const res = await fetch('/ui/plugins/' + encodeURIComponent(name), { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to delete plugin');
                pluginListState = Array.isArray(data.plugins) ? data.plugins : [];
                renderPluginsUI();
                await Promise.all([loadMemoryPreview(), loadHealthUI()]);
                showStatus('Proxy plugin deleted', 'bg-slate-700 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── MCP Servers ── */
function loadMcpSkillsUI() {
    return Promise.all([loadMcpUI(), loadSkillsUI(), loadPluginsUI(), loadCompatibilityUI(), loadMemoryPreview(), loadHealthUI()]);
}

        async function loadMcpUI() {
            const list = document.getElementById('mcpServerList');
            if (!list) return;
            try {
                const res = await fetch('/ui/mcp', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                mcpServerListState = Array.isArray(data.servers) ? data.servers : [];
                renderMcpServers(data);
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function renderMcpServers(data) {
            const list = document.getElementById('mcpServerList');
            if (!list) return;
            const servers = Array.isArray(data.servers) ? data.servers : [];
            const statusMap = new Map((Array.isArray(data.status) ? data.status : []).map(item => [item.name, item]));
            if (servers.length === 0) {
                list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No MCP servers configured yet.</div>';
                return;
            }
            list.innerHTML = servers.map(server => {
                const status = statusMap.get(server.name) || server;
                const state = status.status || (server.enabled === false ? 'disabled' : 'not_started');
                const tools = Array.isArray(status.tools) && status.tools.length
                    ? `<p class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(status.tools.slice(0, 8).join(', '))}${status.tools.length > 8 ? '...' : ''}</p>`
                    : '';
                const error = status.error
                    ? `<p class="mt-2 rounded-xl bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(status.error)}</p>`
                    : '';
                const commandLine = [server.command, ...(server.args || [])].filter(Boolean).join(' ');
                const sourceClass = server.source === 'builtin'
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300';
                const toggleLabel = server.enabled === false ? 'Enable' : 'Disable';
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(server.name)}</h3>
                                    ${renderTinyBadge(state, mcpStatusClass(state))}
                                    ${renderTinyBadge(server.source || 'custom', sourceClass)}
                                    ${server.enabled === false ? renderTinyBadge('disabled', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400') : ''}
                                </div>
                                <p class="mt-2 break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(commandLine || server.command)}</p>
                                ${status.toolCount ? `<p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${status.toolCount} tools registered</p>` : ''}
                                ${tools}
                                ${error}
                            </div>
                            <div class="flex shrink-0 gap-2">
                                <button onclick="fillMcpForm('${server.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">Edit</button>
                                <button onclick="toggleMcpServerUI('${server.name}', ${server.enabled === false ? 'true' : 'false'})" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">${toggleLabel}</button>
                                ${server.source !== 'builtin' ? `<button onclick="deleteMcpServerUI('${server.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function fillMcpForm(name) {
            const server = mcpServerListState.find(item => item.name === name);
            if (!server) return;
            document.getElementById('mcpName').value = server.name || '';
            document.getElementById('mcpCommand').value = server.command || '';
            document.getElementById('mcpArgs').value = server.argsText || (server.args || []).join('\n');
            document.getElementById('mcpEnv').value = server.envText || '';
            document.getElementById('mcpCwd').value = server.cwd || '';
            document.getElementById('mcpEnabled').checked = server.enabled !== false;
        }

        async function saveMcpServerUI() {
            const payload = {
                name: document.getElementById('mcpName').value.trim(),
                command: document.getElementById('mcpCommand').value.trim(),
                args: parseLinesOrJsonArray(document.getElementById('mcpArgs').value),
                env: parseEnvText(document.getElementById('mcpEnv').value),
                cwd: document.getElementById('mcpCwd').value.trim() || undefined,
                enabled: document.getElementById('mcpEnabled').checked
            };
            try {
                const res = await fetch('/ui/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to save MCP server');
                showStatus('MCP server saved and restarted', 'bg-emerald-600 text-white');
                await loadMcpUI();
                await loadMemoryPreview();
                await loadHealthUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function toggleMcpServerUI(name, enabled) {
            try {
                const res = await fetch('/ui/mcp/' + encodeURIComponent(name), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update MCP server');
                mcpServerListState = Array.isArray(data.servers) ? data.servers : mcpServerListState;
                showStatus(enabled ? 'MCP server enabled and restarted' : 'MCP server disabled and restarted', enabled ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-white');
                await Promise.all([loadMcpUI(), loadCompatibilityUI(), loadHealthUI(), loadMemoryPreview()]);
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deleteMcpServerUI(name) {
            const server = mcpServerListState.find(item => item.name === name);
            const action = 'delete';
            if (!confirm(`Are you sure you want to ${action} ${name}?`)) return;
            try {
                const res = await fetch('/ui/mcp/' + encodeURIComponent(name), { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update MCP server');
                showStatus('MCP server deleted', 'bg-slate-700 text-white');
                await Promise.all([loadMcpUI(), loadHealthUI()]);
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function restartMcpServersUI() {
            try {
                showStatus('Restarting MCP servers...', 'bg-slate-700 text-white');
                const res = await fetch('/ui/mcp/restart', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to restart MCP servers');
                await Promise.all([loadMcpUI(), loadHealthUI()]);
                showStatus('MCP servers restarted', 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── Skills ── */
        async function loadSkillsUI() {
            const list = document.getElementById('skillList');
            if (!list) return;
            try {
                const res = await fetch('/ui/skills', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                skillListState = Array.isArray(data.skills) ? data.skills : [];
                renderSkills();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function renderSkills() {
            const list = document.getElementById('skillList');
            if (!list) return;
            if (skillListState.length === 0) {
                list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No custom skills configured yet.</div>';
                return;
            }
            list.innerHTML = skillListState.map(skill => {
                const trigger = skill.trigger
                    ? `<p class="mt-2 font-mono text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(skill.trigger)}</p>`
                    : '';
                const description = skill.description
                    ? `<p class="mt-2 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(skill.description)}</p>`
                    : '';
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(skill.name)}</h3>
                                    ${renderTinyBadge(skill.enabled === false ? 'disabled' : 'enabled', skill.enabled === false ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300')}
                                </div>
                                ${description}
                                ${trigger}
                                <p class="mt-2 line-clamp-3 text-[11px] leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(skill.instructions || '')}</p>
                            </div>
                            <div class="flex shrink-0 gap-2">
                                <button onclick="fillSkillForm('${skill.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">Edit</button>
                                <button onclick="deleteSkillUI('${skill.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function fillSkillForm(name) {
            const skill = skillListState.find(item => item.name === name);
            if (!skill) return;
            document.getElementById('skillName').value = skill.name || '';
            document.getElementById('skillTrigger').value = skill.trigger || '';
            document.getElementById('skillDescription').value = skill.description || '';
            document.getElementById('skillInstructions').value = skill.instructions || '';
            document.getElementById('skillEnabled').checked = skill.enabled !== false;
        }

        async function saveSkillUI() {
            const payload = {
                name: document.getElementById('skillName').value.trim(),
                trigger: document.getElementById('skillTrigger').value.trim(),
                description: document.getElementById('skillDescription').value.trim(),
                instructions: document.getElementById('skillInstructions').value.trim(),
                enabled: document.getElementById('skillEnabled').checked
            };
            try {
                const res = await fetch('/ui/skills', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to save skill');
                showStatus('Skill saved', 'bg-emerald-600 text-white');
                await Promise.all([loadSkillsUI(), loadMemoryPreview(), loadHealthUI()]);
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deleteSkillUI(name) {
            if (!confirm(`Delete skill ${name}?`)) return;
            try {
                const res = await fetch('/ui/skills/' + encodeURIComponent(name), { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to delete skill');
                showStatus('Skill deleted', 'bg-slate-700 text-white');
                await Promise.all([loadSkillsUI(), loadMemoryPreview(), loadHealthUI()]);
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── Toggle collapsible sections ── */
        function toggleSection(elemId) {
            const el = document.getElementById(elemId);
            if (!el) return;
            el.classList.toggle('hidden');
        }

/* ── Memory Preview & Context Limit ── */
        async function loadMemoryPreview() {
            const meta = document.getElementById('memoryPreviewMeta');
            if (!meta) return;
            try {
                const limit = document.getElementById('memoryContextMaxChars')?.value || DEFAULT_MEMORY_CONTEXT_MAX_CHARS;
                const [previewRes, memRes, vecRes, semRes] = await Promise.all([
                    fetch(`/ui/memory/preview?profile=claude&maxChars=${encodeURIComponent(limit)}`, { cache: 'no-store' }),
                    fetch('/ui/memory', { cache: 'no-store' }),
                    fetch('/ui/memory/vector', { cache: 'no-store' }),
                    fetch('/ui/semantic-memory', { cache: 'no-store' })
                ]);
                const preview = await previewRes.json();
                const memory = await memRes.json();
                const vector = await vecRes.json();
                const semantic = await semRes.json();
                if (!previewRes.ok) throw new Error(preview.error || 'Failed to load August memory');

                // Stats bar
                const checkpointCount = (memory.conversation_checkpoints || []).length;
                const facts = Array.isArray(semantic.facts) ? semantic.facts : [];
                const vecCount = vector.count || 0;
                document.getElementById('memFactCount').textContent = formatExactNumber(facts.length);
                document.getElementById('memCheckpointCount').textContent = formatExactNumber(checkpointCount);
                document.getElementById('memVectorCount').textContent = formatExactNumber(vecCount);
                const allTimestamps = [
                    ...(memory.conversation_checkpoints || []).map(c => c.timestamp),
                    ...facts.map(f => f.updated),
                    ...(vector.entries || []).map(e => e.timestamp)
                ].filter(Boolean).sort().reverse();
                document.getElementById('memUpdated').textContent = allTimestamps.length
                    ? 'Last updated: ' + new Date(allTimestamps[0]).toLocaleDateString()
                    : 'Last updated: --';

                // Meta text
                const context = preview.context || {};
                const compactText = context.compacted
                    ? ` August Brain compacted from ${formatExactNumber(context.fullLength || 0)} to ${formatExactNumber(context.finalLength || 0)} characters (limit ${formatExactNumber(context.maxChars || 0)}).`
                    : ` August Brain is ${formatExactNumber(context.finalLength || context.fullLength || 0)} characters (limit ${formatExactNumber(context.maxChars || 0)}).`;
                meta.textContent = `${preview.profile || 'claude'} MEMORY: ${formatExactNumber(preview.length || 0)} characters injected before the client system prompt.${compactText}`;

                // Raw system prompt (hidden by default)
                const rawEl = document.getElementById('memRawPrompt');
                if (rawEl) rawEl.textContent = preview.prompt || '';

                // Semantic facts
                const factsEl = document.getElementById('memFactsContent');
                if (factsEl) {
                    if (facts.length === 0) {
                        factsEl.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic">No semantic facts yet. Facts are auto-extracted from conversations.</div>';
                    } else {
                        factsEl.innerHTML = facts.slice(0, 20).map(f => `
                            <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                                <div class="flex items-center gap-2">
                                    <code class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(f.key)}</code>
                                    <span class="text-[10px] px-1.5 py-0.5 rounded-full ${f.category === 'user_preference' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : f.category === 'project_info' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}">${escMemHtml(f.category || 'general')}</span>
                                </div>
                                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escMemHtml(f.value)}</p>
                            </div>
                        `).join('');
                    }
                }

                // Vector entries
                const vecEl = document.getElementById('memVectorContent');
                if (vecEl) {
                    const entries = vector.entries || [];
                    if (entries.length === 0) {
                        vecEl.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic">No vector entries yet. Auto-memory will populate this as you use the assistant.</div>';
                    } else {
                        vecEl.innerHTML = entries.slice(0, 20).map(e => `
                            <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                                <div class="flex items-center justify-between">
                                    <span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(e.topic)}</span>
                                    <span class="text-[10px] text-slate-400">${new Date(e.timestamp).toLocaleDateString()}</span>
                                </div>
                                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escMemHtml(e.summary)}</p>
                            </div>
                        `).join('');
                    }
                }

                // Checkpoints
                const chkEl = document.getElementById('memCheckpointContent');
                if (chkEl) {
                    const checkpoints = memory.conversation_checkpoints || [];
                    if (checkpoints.length === 0) {
                        chkEl.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic">No checkpoints saved yet.</div>';
                    } else {
                        chkEl.innerHTML = checkpoints.slice(0, 15).map(c => `
                            <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                                <div class="flex items-center justify-between">
                                    <span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(c.topic || 'Checkpoint')}</span>
                                    <span class="text-[10px] text-slate-400">${new Date(c.timestamp).toLocaleDateString()}</span>
                                </div>
                                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escMemHtml(c.summary || '')}</p>
                            </div>
                        `).join('');
                    }
                }

            } catch (e) {
                if (meta) meta.textContent = 'Failed to load August memory: ' + e.message;
            }
        }

        async function saveMemoryContextLimitUI() {
            const input = document.getElementById('memoryContextMaxChars');
            const value = Number.parseInt(input?.value, 10);
            if (!Number.isFinite(value) || value < 8000 || value > MAX_MEMORY_CONTEXT_CHARS) {
                showStatus('Brain limit must be between 8,000 and 64,000 characters', 'bg-red-600 text-white');
                return;
            }
            const res = await fetch('/ui/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ memoryContextMaxChars: value })
            });
            if (!res.ok) {
                showStatus('Failed to save brain limit', 'bg-red-600 text-white');
                return;
            }
            currentConfigState = { ...currentConfigState, memoryContextMaxChars: value };
            showStatus('Brain context limit saved', 'bg-green-600 text-white');
            await Promise.all([loadMemoryPreview(), loadHealthUI()]);
        }

/* ── August / Semantic Memory ── */
        async function loadSemanticMemoryUI() {
            const list = document.getElementById('semanticMemoryList');
            if (!list) return;
            try {
                const res = await fetch('/ui/semantic-memory', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const facts = Array.isArray(data.facts) ? data.facts : [];
                if (facts.length === 0) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No semantic memory facts stored yet. Facts are auto-extracted from conversations or set via august__remember.</div>';
                    return;
                }
                list.innerHTML = facts.map((f, i) => `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <code class="text-xs font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(f.key)}</code>
                                    ${renderTinyBadge(f.category, f.category === 'user_preference' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : f.category === 'user_detail' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' : f.category === 'project_info' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : f.category === 'workflow_rule' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                                    ${f.ttl ? renderTinyBadge('TTL: ' + new Date(f.ttl).toLocaleDateString(), 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300') : ''}
                                </div>
                                <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">${escapeHtml(f.value)}</p>
                                <p class="mt-1 text-[10px] text-slate-400 dark:text-slate-500">source: ${escapeHtml(f.source || 'unknown')} &middot; updated: ${new Date(f.updated).toLocaleString()}</p>
                            </div>
                            <button onclick="deleteSemanticFactUI('${escapeHtml(f.key)}')" class="minimal-button shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>
                        </div>
                    </div>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        async function deleteSemanticFactUI(key) {
            if (!confirm(`Delete semantic fact "${key}"?`)) return;
            try {
                const res = await fetch('/ui/semantic-memory', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key })
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                showStatus('Semantic fact deleted', 'bg-slate-700 text-white');
                loadSemanticMemoryUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        function loadAugustUI() {
            loadSemanticMemoryUI();
            loadSpecialistUI();
            loadUrlMcpUI();
            loadVectorMemoryUI();
            if (document.getElementById('supermemoryUrl')) {
                fetch('/ui/config/safe', { cache: 'no-store' }).then(r=>r.json()).then(cfg => {
                    const urlEl = document.getElementById('supermemoryUrl');
                    if (urlEl && cfg.supermemoryUrl) urlEl.value = cfg.supermemoryUrl;
                }).catch(() => {});
            }
        }

/* ── Vector Memory ── */
        async function loadVectorMemoryUI() {
            const list = document.getElementById('vectorMemoryList');
            const count = document.getElementById('vectorCount');
            if (!list) return;
            try {
                const res = await fetch('/ui/memory/vector', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error('HTTP ' + res.status);
                if (count) count.textContent = data.count || 0;
                if (!data.count || data.count === 0) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No vector entries yet. Auto-memory extraction will populate this as you use the assistant.</div>';
                    return;
                }
                list.innerHTML = data.entries.map(e => `
                    <div class="vector-entry rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-3">
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(e.topic)}</span>
                            <span class="text-[10px] text-slate-400">${new Date(e.timestamp).toLocaleDateString()}</span>
                        </div>
                        <p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${escMemHtml(e.summary)}</p>
                    </div>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="text-xs text-red-500">${escMemHtml(e.message)}</div>`;
            }
        }

        function filterVectorMemory(value) {
            const q = String(value || '').toLowerCase();
            document.querySelectorAll('.vector-entry').forEach(el => {
                el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
        }

        async function loadSpecialistUI() {
            const list = document.getElementById('specialistList');
            if (!list) return;
            try {
                const res = await fetch('/ui/config/safe', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const cfg = await res.json();
                const eps = cfg.specialistEndpoints || {};
                if (Object.keys(eps).length === 0) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No specialist endpoints configured. Add specialistEndpoints to config.json.</div>';
                    return;
                }
                list.innerHTML = Object.entries(eps).map(([name, ep]) => `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex items-center gap-2 mb-2">
                            ${renderTinyBadge(name, 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300')}
                        </div>
                        <p class="mt-2 text-[11px] text-slate-600 dark:text-slate-300 font-mono break-all">${escapeHtml(ep.url || 'N/A')}</p>
                        <p class="mt-1 text-[10px] text-slate-400 dark:text-slate-500">model: ${escapeHtml(ep.model || 'MiniMax-M2.7')} &middot; max_tokens: ${ep.maxTokens || 4096} &middot; timeout: ${(ep.timeoutMs || 60000) / 1000}s</p>
                    </div>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

/* ── URL MCP ── */
        async function saveUrlMcpUI() {
            const name = document.getElementById('urlMcpName')?.value?.trim();
            const url = document.getElementById('urlMcpUrl')?.value?.trim();
            const enabled = document.getElementById('urlMcpEnabled')?.checked !== false;
            const headersRaw = document.getElementById('urlMcpHeaders')?.value?.trim();
            const status = document.getElementById('urlMcpStatus');
            if (!name) { status.textContent = 'Name is required'; return; }
            if (!url) { status.textContent = 'URL is required'; return; }

            let headers = {};
            if (headersRaw) {
                try { headers = JSON.parse(headersRaw); } catch (e) { status.textContent = 'Invalid JSON in headers'; return; }
            }

            try {
                const res = await fetch('/ui/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, url, enabled, headers, source: 'custom' })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to save');
                status.textContent = 'Saved! Restart MCP servers to apply.';
                status.className = 'text-[10px] text-emerald-600';
                loadUrlMcpUI();
            } catch (e) {
                status.textContent = e.message;
                status.className = 'text-[10px] text-red-600';
            }
        }

        async function loadUrlMcpUI() {
            const list = document.getElementById('urlMcpList');
            if (!list) return;
            try {
                const res = await fetch('/ui/mcp', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const servers = Array.isArray(data.servers) ? data.servers : [];
                const urlServers = servers.filter(s => s.url);
                if (urlServers.length === 0) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No URL-based MCP servers configured. Add one using the form.</div>';
                    return;
                }
                const statusMap = new Map((Array.isArray(data.status) ? data.status : []).map(s => [s.name, s]));
                list.innerHTML = urlServers.map(s => {
                    const st = statusMap.get(s.name) || {};
                    const isRunning = st.status === 'running';
                    return `
                        <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0 flex-1">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(s.name)}</h3>
                                        ${renderTinyBadge(isRunning ? 'running' : st.status || 'unknown', isRunning ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                                        ${s.enabled === false ? renderTinyBadge('disabled', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400') : ''}
                                    </div>
                                    <p class="mt-2 text-xs text-slate-600 dark:text-slate-300 font-mono break-all">${escapeHtml(s.url)}</p>
                                    <p class="mt-1 text-[10px] text-slate-400 dark:text-slate-500">${s.toolCount || 0} tools</p>
                                </div>
                                <button onclick="deleteMcpServerUI('${escapeHtml(s.name)}')" class="minimal-button shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

/* ── Supermemory ── */
        async function saveSupermemoryConfigUI() {
            const apiKey = document.getElementById('supermemoryApiKey')?.value?.trim();
            const url = document.getElementById('supermemoryUrl')?.value?.trim();
            const status = document.getElementById('supermemoryStatus');
            try {
                const payload = {};
                if (apiKey) payload.supermemoryApiKey = apiKey;
                if (url) payload.supermemoryUrl = url;
                payload.profile = 'claude';
                const res = await fetch('/ui/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                status.textContent = 'Saved';
                status.className = 'text-[10px] text-emerald-600';
            } catch (e) {
                status.textContent = e.message;
                status.className = 'text-[10px] text-red-600';
            }
        }

        async function testSupermemoryUI() {
            const query = document.getElementById('supermemoryTestQuery')?.value?.trim();
            const result = document.getElementById('supermemoryTestResult');
            if (!query) { result.textContent = 'Enter a search query'; return; }
            result.textContent = 'Searching...';
            try {
                const cfg = await (await fetch('/ui/config/safe', { cache: 'no-store' })).json();
                const apiKey = cfg.supermemoryApiKey;
                if (!apiKey) { result.textContent = 'No supermemory API key configured'; return; }
                const searchRes = await fetch('https://supermemory.ai/api/search?q=' + encodeURIComponent(query), {
                    headers: { 'Authorization': 'Bearer ' + apiKey },
                    signal: AbortSignal.timeout(10000)
                });
                if (!searchRes.ok) {
                    result.textContent = 'HTTP ' + searchRes.status + ': ' + (await searchRes.text()).slice(0, 200);
                    return;
                }
                const data = await searchRes.json();
                const items = data.results || data.data || [];
                if (items.length === 0) { result.textContent = 'No results'; return; }
                result.textContent = items.slice(0, 5).map((r, i) =>
                    `[${i + 1}] ${r.title || r.content?.slice(0, 100) || '(untitled)'}`
                ).join('\n---\n');
            } catch (e) {
                result.textContent = e.message;
            }
        }


