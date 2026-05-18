const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getConfig, saveConfig, getProfile, saveProfile, getBookmarks, saveBookmark, deleteBookmark } = require('./utils/config');
const { getActivityLog, startRequest, endRequest, getRequestLog, getPendingRequests, getFilteredRequests, getStats, getRequestDetails, getRequestDetail, getConversations, addSSEClient, removeSSEClient } = require('./utils/logger');
const anthropicAdapter = require('./adapters/anthropic');
const openaiAdapter = require('./adapters/openai');
const { getMcpServerStatus, restartMcpServers, startMcpServers } = require('./utils/mcp-client');
const { deleteMcpServer, getMcpServersForUi, saveCustomMcpServer, setMcpServerEnabled } = require('./utils/mcp-registry');
const { deleteSkill, getSkills, saveSkill } = require('./utils/skills');
const { deletePlugin, getPlugins, setPluginEnabled } = require('./utils/plugins');
const { readJsonBody, sendError, sendJson } = require('./utils/http-utils');
const { redactForDisplay } = require('./utils/redact');
const { DEFAULT_CONTEXT_MAX_CHARS, buildSystemPromptDetails } = require('./utils/context-builder');
const { identifyClient } = require('./utils/client-identity');
const { executeManagedWebTool } = require('./utils/local-web');
const { createHostFilesFolder, getCompatibilityStatus } = require('./utils/compatibility');
const { importCapabilityLink } = require('./utils/link-importer');
const { importSkillFromLink } = require('./utils/skill-importer');
const { getCapabilityHealth } = require('./utils/health');
const { getBrainDiagnostics } = require('./utils/brain-diagnostics');
const { listMemoryItems, searchMemory, updateMemoryItem } = require('./utils/memory-lifecycle');
const { answerWorkbenchBtw, approveWorkbenchPlan, createWorkbenchSession, getWorkbenchGoalStatus, listAgentRegistry, listProxyCapabilities, resetWorkbenchSession, sendWorkbenchMessageStream, updateWorkbenchGoal } = require('./utils/workbench');
const sqliteMemoryStore = require('./utils/sqlite-memory-store');
const memoryProviders = require('./utils/memory-providers');
const agentRegistry = require('./utils/agent-registry');
const agentSessions = require('./utils/agent-sessions');
const terminalService = require('./utils/terminal-service');
const automationJobs = require('./utils/automation-jobs');
const memoryGovernance = require('./utils/memory-governance');
const hostAgent = require('./utils/host-agent');

const UI_PATH = path.join(__dirname, 'ui.html');
const APP_PATH = path.join(__dirname, 'app.html');
const TAILWIND_CSS_PATH = path.join(__dirname, 'tailwind.generated.css');
const LISTEN_PORT = Number(process.env.CLAUDISH_PROXY_PORT || process.env.PORT || 8080);
const MAX_CONTEXT_MAX_CHARS = 64000;

function summarizeRequestHeaders(headers) {
    const result = {};
    Object.entries(headers || {}).forEach(([key, value]) => {
        const lowered = String(key || '').toLowerCase();
        if (lowered.includes('auth') || lowered.includes('key') || lowered.includes('token') || lowered.includes('cookie')) return;
        result[key] = value;
    });
    return result;
}

function getPeriodContext(url) {
    return {
        tzOffsetMinutes: url.searchParams.get('tzOffsetMinutes'),
        weekStartsOn: url.searchParams.get('weekStartsOn')
    };
}

function stripKnownSuffixes(value) {
    return value
        .replace(/\/v1\/messages$/i, '')
        .replace(/\/messages$/i, '')
        .replace(/\/v1\/chat\/completions$/i, '')
        .replace(/\/chat\/completions$/i, '')
        .replace(/\/v1\/responses$/i, '')
        .replace(/\/responses$/i, '')
        .replace(/\/v1\/models$/i, '')
        .replace(/\/models$/i, '');
}

function normalizeOpenAIBaseUrl(baseUrl) {
    let normalized = stripKnownSuffixes((baseUrl || '').trim());
    if (!normalized) return '';
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    if (/^https:\/\/api\.minimax\.io\/anthropic$/i.test(normalized)) {
        return 'https://api.minimax.io/v1';
    }
    if (!/\/v\d+$/i.test(normalized) && !/\/api\/v\d+$/i.test(normalized)) normalized += '/v1';
    return normalized;
}

function normalizeAnthropicBaseUrl(baseUrl) {
    let normalized = stripKnownSuffixes((baseUrl || '').trim());
    if (!normalized) return '';
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    if (/^https:\/\/api\.minimax\.io\/v\d+$/i.test(normalized)) {
        return 'https://api.minimax.io/anthropic';
    }
    if (/^https:\/\/api\.anthropic\.com$/i.test(normalized)) {
        return 'https://api.anthropic.com';
    }
    if (/\/v\d+$/i.test(normalized)) {
        return normalized.replace(/\/v\d+$/i, '');
    }
    return normalized;
}

function buildTargetUrlForProfile(profile, baseUrl) {
    const lowerBase = (baseUrl || '').toLowerCase();
    // Detect if this is likely an OpenAI-compatible endpoint even if we're in the Claude profile
    const isOpenAIHint = lowerBase.includes('openai.com') || 
                         lowerBase.includes('openrouter.ai') || 
                         lowerBase.includes('groq.com') || 
                         lowerBase.includes('completions') ||
                         lowerBase.includes('localhost:11434'); // Ollama default

    if (profile === 'claude' && !isOpenAIHint) {
        const anthropicBase = normalizeAnthropicBaseUrl(baseUrl);
        if (!anthropicBase) return '';
        return `${anthropicBase}/v1/messages`;
    }

    const openaiBase = normalizeOpenAIBaseUrl(baseUrl);
    if (!openaiBase) return '';
    if (/^https:\/\/api\.minimax\.io\/v\d+$/i.test(openaiBase)) {
        return 'https://api.minimax.io/v1/text/chatcompletion_v2';
    }
    return `${openaiBase}/chat/completions`;
}

function buildModelsUrl(baseUrl) {
    const openaiBase = normalizeOpenAIBaseUrl(baseUrl);
    if (!openaiBase) return '';
    return `${openaiBase}/models`;
}

function buildTestPayload(profile, model) {
    if (profile === 'claude') {
        return {
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'respond with only the word "WORKING"' }]
        };
    }

    return {
        model,
        messages: [{ role: 'user', content: 'respond with only the word "WORKING"' }]
    };
}

function buildAuthHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (!apiKey) return headers;
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
    return headers;
}

function buildTestHeaders(profile, apiKey) {
    const headers = buildAuthHeaders(apiKey);
    if (profile === 'claude') {
        headers['anthropic-version'] = '2023-06-01';
    }
    return headers;
}

const server = http.createServer(async (req, res) => {
    // ── URL normalization ──
    const originalUrl = req.url;
    let cleanPath = originalUrl
        .replace(/^\/v1\/v1\//, '/v1/')
        .replace(/^\/v1\/messages/, '/v1/messages');

    if (originalUrl.includes('/v1/')) {
        console.log(`[Proxy Incoming]: ${req.method} ${originalUrl} -> Normalized: ${cleanPath}`);
    }
    if ((req.headers['user-agent'] || '').toLowerCase().includes('claude')) {
        console.log('[Proxy Debug Bridge Claude Headers]:', JSON.stringify({
            method: req.method,
            url: originalUrl,
            normalized: cleanPath,
            headers: summarizeRequestHeaders(req.headers)
        }));
    }

    // ── UI endpoints ──
    if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(fs.readFileSync(UI_PATH, 'utf8'));
    }

    if (req.url === '/app' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(fs.readFileSync(APP_PATH, 'utf8'));
    }

    if (req.url === '/favicon.ico' && req.method === 'GET') {
        res.writeHead(204);
        return res.end();
    }

    if (req.url === '/tailwind.generated.css' && req.method === 'GET') {
        if (!fs.existsSync(TAILWIND_CSS_PATH)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Generated Tailwind stylesheet is missing.');
        }
        res.writeHead(200, {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        return res.end(fs.readFileSync(TAILWIND_CSS_PATH, 'utf8'));
    }

    // ── Serve /ui/* static files (CSS, JS) ──
    if (req.url.startsWith('/ui/') && (req.url.endsWith('.js') || req.url.endsWith('.css')) && req.method === 'GET') {
        const relativePath = req.url.replace(/^\/ui\//, '');
        const filePath = path.join(__dirname, 'ui', relativePath);
        if (fs.existsSync(filePath)) {
            const ext = path.extname(filePath);
            const mime = ext === '.css' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
            res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
            return res.end(fs.readFileSync(filePath, 'utf8'));
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
    }

    if (req.url === '/ui/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getConfig()));
    }

    if (req.url === '/ui/config/safe' && req.method === 'GET') {
        return sendJson(res, redactForDisplay(getConfig()));
    }

    if (req.url === '/ui/compatibility' && req.method === 'GET') {
        return sendJson(res, getCompatibilityStatus());
    }

    if (req.url === '/ui/health' && req.method === 'GET') {
        return sendJson(res, getCapabilityHealth());
    }

    if (req.url === '/ui/brain/diagnostics' && req.method === 'GET') {
        return sendJson(res, getBrainDiagnostics());
    }

    if (req.url === '/ui/workbench/session' && req.method === 'POST') {
        try {
            return sendJson(res, createWorkbenchSession(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/capabilities' && req.method === 'GET') {
        return sendJson(res, listProxyCapabilities());
    }

    if (req.url.startsWith('/ui/workbench/agents') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        return sendJson(res, listAgentRegistry(url.searchParams.get('active') || 'build'));
    }

    if (req.url.startsWith('/ui/workbench/goal') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        return sendJson(res, getWorkbenchGoalStatus(url.searchParams.get('sessionId')));
    }

    if (req.url === '/ui/workbench/goal' && req.method === 'POST') {
        try {
            return sendJson(res, updateWorkbenchGoal(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/btw' && req.method === 'POST') {
        try {
            return sendJson(res, await answerWorkbenchBtw(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/chat' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req, { limitBytes: 2 * 1024 * 1024 });
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            await sendWorkbenchMessageStream(data, (type, payload) => {
                res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
            });
            res.write('event: done\ndata: {}\n\n');
            res.end();
        } catch (e) {
            try {
                res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
                res.end();
            } catch (_) {}
        }
        return;
    }

    if (req.url === '/ui/workbench/approve' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            return sendJson(res, approveWorkbenchPlan(data.sessionId));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/reset' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            return sendJson(res, resetWorkbenchSession(data.sessionId, data.provider, data.agentId));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/host-agent/status' && req.method === 'GET') {
        hostAgent.getStatus().then(status => sendJson(res, { status })).catch(() => sendJson(res, { status: 'disconnected' }));
        return;
    }

    if (req.url === '/ui/host-files/folder' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            return sendJson(res, {
                folder: createHostFilesFolder(data.name),
                compatibility: getCompatibilityStatus()
            });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/plugins' && req.method === 'GET') {
        return sendJson(res, { plugins: getPlugins() });
    }

    if (req.url.startsWith('/ui/plugins/') && req.method === 'DELETE') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            return sendJson(res, { ...deletePlugin(name), plugins: getPlugins() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/plugins/') && req.method === 'PATCH') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            const data = await readJsonBody(req);
            const plugin = setPluginEnabled(name, data.enabled !== false);
            return sendJson(res, { plugin, plugins: getPlugins() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/plugins/') && req.url.endsWith('/refresh') && req.method === 'POST') {
        try {
            const parts = req.url.split('/');
            const name = decodeURIComponent(parts[3]);
            const plugin = getPlugins().find(item => item.name === name);
            if (!plugin?.sourceUrl) throw new Error('Plugin has no source URL to refresh.');
            const imported = await importCapabilityLink({ url: plugin.sourceUrl, enableMcp: false });
            return sendJson(res, { imported, plugins: getPlugins() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/import-link' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            const imported = await importSkillFromLink({
                url: data.url,
                enableMcp: data.enableMcp === true,
                restartMcp: true
            });
            const status = imported.mcpStatus || getMcpServerStatus();
            return sendJson(res, { imported, status, plugins: getPlugins() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/mcp' && req.method === 'GET') {
        return sendJson(res, {
            servers: getMcpServersForUi(),
            status: getMcpServerStatus()
        });
    }

    if (req.url === '/ui/mcp' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            const saved = saveCustomMcpServer(data);
            const status = await restartMcpServers(getProfile('claude')?.apiKey || '');
            return sendJson(res, { saved, status });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/mcp/') && req.method === 'PATCH') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            const data = await readJsonBody(req);
            const saved = setMcpServerEnabled(name, data.enabled !== false);
            const status = await restartMcpServers(getProfile('claude')?.apiKey || '');
            return sendJson(res, { saved, status, servers: getMcpServersForUi() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/mcp/restart' && req.method === 'POST') {
        try {
            const status = await restartMcpServers(getProfile('claude')?.apiKey || '');
            return sendJson(res, { status });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url.startsWith('/ui/mcp/') && req.method === 'DELETE') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            const result = deleteMcpServer(name);
            const status = await restartMcpServers(getProfile('claude')?.apiKey || '');
            return sendJson(res, { ...result, status });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/skills' && req.method === 'GET') {
        return sendJson(res, { skills: getSkills() });
    }

    if (req.url === '/ui/skills' && req.method === 'POST') {
        try {
            const saved = saveSkill(await readJsonBody(req));
            return sendJson(res, { saved, skills: getSkills() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/skills/') && req.method === 'DELETE') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            return sendJson(res, { ...deleteSkill(name), skills: getSkills() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/memory/items' && req.method === 'GET') {
        return sendJson(res, { items: listMemoryItems() });
    }

    if (req.url === '/ui/memory/items' && req.method === 'PATCH') {
        try {
            return sendJson(res, updateMemoryItem(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/memory/search') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        return sendJson(res, searchMemory(url.searchParams.get('q') || ''));
    }

    if (req.url === '/ui/memory/store/status' && req.method === 'GET') {
        return sendJson(res, sqliteMemoryStore.getMemoryStoreStatus());
    }

    if (req.url === '/ui/memory/store/rebuild' && req.method === 'POST') {
        try {
            const { readVectorEntries, syncSqliteMemoryStore } = require('./utils/vector-db');
            const result = syncSqliteMemoryStore();
            return sendJson(res, { ...result, vectorEntries: readVectorEntries().length, status: sqliteMemoryStore.getMemoryStoreStatus() });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url.startsWith('/ui/memory/providers') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const query = url.searchParams.get('q') || '';
        return sendJson(res, {
            providers: memoryProviders.listMemoryProviders(),
            recalled: query ? memoryProviders.prefetchAll(query) : []
        });
    }

    if (req.url.startsWith('/ui/memory/provider-events') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        return sendJson(res, {
            events: sqliteMemoryStore.listProviderEvents({ limit: url.searchParams.get('limit') || 25 })
        });
    }

    if (req.url.startsWith('/ui/memory/governance') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        return sendJson(res, memoryGovernance.searchGovernanceTargets(url.searchParams.get('q') || ''));
    }

    if (req.url === '/ui/memory/governance' && req.method === 'POST') {
        try {
            return sendJson(res, memoryGovernance.applyMemoryGovernance(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/memory/vector' && req.method === 'GET') {
        const { readVectorEntries } = require('./utils/vector-db');
        const entries = readVectorEntries().map(e => ({
            id: e.id,
            topic: e.topic,
            summary: e.summary,
            timestamp: e.timestamp,
            metadata: e.metadata,
            tags: e.tags
        }));
        return sendJson(res, { entries, count: entries.length });
    }

    if (req.url === '/ui/agents' && req.method === 'GET') {
        return sendJson(res, { agents: agentRegistry.getAgents() });
    }

    if (req.url === '/ui/agents' && req.method === 'POST') {
        try {
            return sendJson(res, { agent: agentRegistry.saveAgent(await readJsonBody(req)), agents: agentRegistry.getAgents() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/agents/permissions' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, {
                permissions: agentRegistry.deriveChildAgentPermissions(body.parentAgent || 'build', body.childAgent || 'general')
            });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/agent-sessions' && req.method === 'GET') {
        return sendJson(res, agentSessions.listAgentSessions());
    }

    if (req.url === '/ui/agent-sessions' && req.method === 'POST') {
        try {
            return sendJson(res, { session: agentSessions.createAgentSession(await readJsonBody(req)), ...agentSessions.listAgentSessions() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/agent-sessions/') && !req.url.startsWith('/ui/agent-sessions/.') ) {
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const parts = url.pathname.split('/').map(part => decodeURIComponent(part));
            const sessionId = parts[3];
            const action = parts[4] || '';
            const requestId = parts[5] || '';
            if (!sessionId) throw new Error('Agent session id is required');
            if (!action && req.method === 'GET') {
                return sendJson(res, agentSessions.getAgentSession(sessionId));
            }
            if (!action && req.method === 'PATCH') {
                return sendJson(res, { session: agentSessions.updateAgentSession(sessionId, await readJsonBody(req)) });
            }
            if (!action && req.method === 'DELETE') {
                return sendJson(res, agentSessions.deleteAgentSession(sessionId, { includeChildren: url.searchParams.get('includeChildren') === 'true' }));
            }
            if (action === 'todos' && req.method === 'POST') {
                const body = await readJsonBody(req);
                return sendJson(res, agentSessions.writeTodos(sessionId, body.todos || [], { merge: body.merge === true }));
            }
            if (action === 'permissions' && !requestId && req.method === 'POST') {
                return sendJson(res, agentSessions.addPermissionRequest(sessionId, await readJsonBody(req)));
            }
            if (action === 'permissions' && requestId && req.method === 'POST') {
                const body = await readJsonBody(req);
                return sendJson(res, agentSessions.respondPermission(sessionId, requestId, body.response || (body.approve === false ? 'reject' : 'once')));
            }
            if (action === 'questions' && !requestId && req.method === 'POST') {
                return sendJson(res, agentSessions.addQuestionRequest(sessionId, await readJsonBody(req)));
            }
            if (action === 'questions' && requestId && req.method === 'POST') {
                const body = await readJsonBody(req);
                return sendJson(res, agentSessions.respondQuestion(sessionId, requestId, body.answer));
            }
            if (action === 'tree-request' && req.method === 'GET') {
                return sendJson(res, { request: agentSessions.findTreeRequest(sessionId, url.searchParams.get('type') || 'permission') });
            }
            if (action === 'run' && req.method === 'POST') {
                return sendJson(res, await agentSessions.startSessionRun(sessionId, await readJsonBody(req)));
            }
            if (action === 'cancel' && req.method === 'POST') {
                const body = await readJsonBody(req);
                return sendJson(res, { session: agentSessions.cancelAgentSession(sessionId, body.reason || 'cancelled from dashboard') });
            }
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/terminal/sessions' && req.method === 'GET') {
        return sendJson(res, { sessions: terminalService.listTerminalSessions(), approvals: terminalService.listTerminalApprovals() });
    }

    if (req.url === '/ui/terminal/sessions' && req.method === 'POST') {
        try {
            return sendJson(res, terminalService.createTerminalSession(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/terminal/buffer') && req.method === 'GET') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            return sendJson(res, terminalService.readTerminalBuffer(url.searchParams.get('id')));
        } catch (e) {
            return sendError(res, e, 404);
        }
    }

    if (req.url === '/ui/terminal/input' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, terminalService.writeTerminalInput(body.id, body.input, { approved: body.approved }));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/terminal/command' && req.method === 'POST') {
        try {
            return sendJson(res, await terminalService.submitTerminalCommand(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/terminal/approve' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, await terminalService.approveTerminalRequest(body.requestId, { approve: body.approve !== false }));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/terminal/sessions/') && req.method === 'DELETE') {
        const id = decodeURIComponent(req.url.split('/').pop());
        return sendJson(res, { deleted: terminalService.closeTerminalSession(id) });
    }

    if (req.url === '/ui/automations' && req.method === 'GET') {
        return sendJson(res, automationJobs.listAutomationJobs());
    }

    if (req.url === '/ui/automations' && req.method === 'POST') {
        try {
            return sendJson(res, { job: automationJobs.saveAutomationJob(await readJsonBody(req)), ...automationJobs.listAutomationJobs() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/automations/run' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, await automationJobs.runAutomationJob(body.id, { approved: body.approved }));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/automations/') && req.method === 'DELETE') {
        const id = decodeURIComponent(req.url.split('/').pop());
        return sendJson(res, { deleted: automationJobs.deleteAutomationJob(id) });
    }

    // ── Real-time SSE stream ──
    if (req.url.startsWith('/ui/stream') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'  // disable nginx/proxy buffering
        });
        res.write(':connected\n\n'); // initial SSE comment to flush headers
        addSSEClient(res, period, periodContext);
        req.on('close', () => removeSSEClient(res));
        return;
    }

    if (req.url === '/ui/activity' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getActivityLog()));
    }

    if (req.url.startsWith('/ui/requests') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            pending: getPendingRequests(),
            completed: getFilteredRequests(period, periodContext)
        }));
    }

    if (req.url.startsWith('/ui/stats') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getStats(period, periodContext)));
    }

    if (req.url.startsWith('/ui/conversations') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getConversations(period, periodContext)));
    }

    if (req.url === '/ui/save' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const data = JSON.parse(body);
            if (data.profile) {
                const profileData = {
                    currentModel: data.currentModel,
                    targetUrl: data.targetUrl,
                    apiKey: data.apiKey
                };
                if (data._upstreamModel !== undefined) profileData._upstreamModel = data._upstreamModel;
                if (data.contextWindow) profileData.contextWindow = parseInt(data.contextWindow, 10);
                if (data.inputCostPer1M !== undefined) profileData.inputCostPer1M = Number(data.inputCostPer1M) || 0;
                if (data.outputCostPer1M !== undefined) profileData.outputCostPer1M = Number(data.outputCostPer1M) || 0;
                saveProfile(data.profile, profileData);
                // Also save customProvider to config root if present
                if (data.customProvider) {
                    const config = getConfig();
                    config.customProvider = data.customProvider;
                    saveConfig(config);
                }
            } else {
                // Backward compatibility: save to root
                const config = getConfig();
                Object.assign(config, data);
                if (data.requestLogLimit !== undefined) {
                    config.requestLogLimit = Math.max(100, parseInt(data.requestLogLimit, 10) || 5000);
                }
                if (data.pendingRequestTimeoutMinutes !== undefined) {
                    config.pendingRequestTimeoutMinutes = Math.max(1, parseInt(data.pendingRequestTimeoutMinutes, 10) || 10);
                }
                if (data.memoryContextMaxChars !== undefined) {
                    const parsedLimit = parseInt(data.memoryContextMaxChars, 10);
                    config.memoryContextMaxChars = Math.max(8000, Math.min(MAX_CONTEXT_MAX_CHARS, Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_CONTEXT_MAX_CHARS));
                }
                saveConfig(config);
            }
            res.writeHead(200);
            res.end('OK');
        });
        return;
    }

    if (req.url.startsWith('/ui/context') && req.method === 'GET') {
        const { inferFromModelId } = require('./utils/models');
        const url = new URL(req.url, `http://${req.headers.host}`);
        const modelId = url.searchParams.get('model');
        const inferred = inferFromModelId(modelId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(inferred || { inputTokens: 32768, outputTokens: 4096 }));
    }

    if (req.url.startsWith('/ui/details') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getRequestDetails(period, periodContext)));
    }

    if (req.url.startsWith('/ui/detail/') && req.method === 'GET') {
        const reqId = req.url.split('/').pop();
        const detail = getRequestDetail(reqId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(detail || { error: 'Not found' }));
    }

    if (req.url === '/ui/memory' && req.method === 'GET') {
        const { readAugustCoreMemory } = require('./utils/august-tools');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(readAugustCoreMemory()));
    }

    if (req.url.startsWith('/ui/memory/preview') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const profileName = url.searchParams.get('profile') || 'claude';
        const profile = getProfile(profileName);
        const model = profileName === 'claude'
            ? (profile?._upstreamModel || profile?.currentModel)
            : profile?.currentModel;
        const contextMaxChars = Number(url.searchParams.get('maxChars') || getConfig().memoryContextMaxChars || DEFAULT_CONTEXT_MAX_CHARS);
        const details = buildSystemPromptDetails(null, {
            model,
            targetUrl: profile?.targetUrl,
            includeWindowsContext: profileName !== 'claude',
            contextMaxChars
        });
        return sendJson(res, {
            profile: profileName,
            model,
            targetUrl: profile?.targetUrl,
            length: details.length,
            prompt: details.prompt,
            context: details.globalContext
        });
    }

    if (req.url === '/ui/memory' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const data = JSON.parse(body);
            const { readAugustCoreMemory, writeAugustCoreMemory } = require('./utils/august-tools');
            const memory = readAugustCoreMemory();
            if (data.global_context !== undefined) memory.global_context = data.global_context;
            if (data.user_profile !== undefined) memory.user_profile = data.user_profile;
            writeAugustCoreMemory(memory);
            res.writeHead(200);
            res.end('OK');
        });
        return;
    }

    if (req.url === '/ui/models' && req.method === 'GET') {
        const providers = [
            { name: 'Kilocode', url: 'https://api.kilo.ai/api/gateway', base: 'https://api.kilo.ai/api/gateway', key: process.env.KILOCODE_API_KEY },
            { name: 'Opencode', url: 'https://opencode.ai/zen/v1', base: 'https://opencode.ai/zen/v1', key: process.env.OPENCODE_API_KEY },
            { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY },
            { name: 'Cline AI', url: 'https://api.cline.bot/api/v1', base: 'https://api.cline.bot/api/v1', key: process.env.CLINE_API_KEY || '' }
        ];

        Promise.all(providers.map(async p => {
            try {
                if (!p.key || p.key === 'undefined') return [];
                if (!p.key && p.name === 'OpenRouter') return [];

                const fetchUrl = p.name === 'Cline AI'
                    ? 'https://openrouter.ai/api/v1/models'
                    : `${p.url}/models`;

                const fetchRes = await fetch(fetchUrl, {
                    headers: p.key ? { 'Authorization': `Bearer ${p.key}` } : {},
                    signal: AbortSignal.timeout(10000)
                });

                if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
                const data = await fetchRes.json();

                return (data.data || []).map(m => ({
                    id: m.id,
                    name: `[${p.name}] ${m.id}`,
                    provider: p.name,
                    url: `${p.url}/chat/completions`,
                    base: p.base,
                    key: p.key
                })).filter(m => {
                    const id = m.id.toLowerCase();
                    return id.includes(':free') || id.includes('-free') || id.includes('auto');
                });
            } catch (e) {
                console.error(`Failed to fetch models from ${p.name}:`, e.message);
                if (p.name === 'Cline AI') {
                    return [
                        { id: 'minimax/minimax-m2.5:free', name: `[${p.name}] minimax/minimax-m2.5:free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key },
                        { id: 'google/gemini-2.0-flash-exp:free', name: `[${p.name}] gemini-2.0-flash-exp:free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key },
                        { id: 'tencent/hy3-preview:free', name: `[${p.name}] tencent/hy3-preview:free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key }
                    ];
                }
                if (p.name !== 'OpenRouter') {
                    return [
                        { id: 'hy3-preview-free', name: `[${p.name}] hy3-preview-free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key },
                        { id: 'ling-2.6-flash-free', name: `[${p.name}] ling-2.6-flash-free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key },
                        { id: 'minimax-m2.5-free', name: `[${p.name}] minimax-m2.5-free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key }
                    ];
                }
                return [];
            }
        })).then(results => {
            const allModels = results.flat();
            const uniqueModels = Array.from(new Map(allModels.map(m => [m.id, m])).values());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(uniqueModels));
        }).catch(err => {
            console.error('[UI /ui/models] Unexpected error:', err.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([])); // always respond so the UI never hangs
        });
        return;
    }

    if (req.url === '/ui/semantic-memory' && req.method === 'GET') {
        const { getAllFacts, factCount } = require('./utils/semantic-memory');
        return sendJson(res, { facts: getAllFacts(), count: factCount() });
    }

    if (req.url === '/ui/supermemory/test' && req.method === 'POST') {
        try {
            const { getSupermemorySettings, searchSupermemory, summarizeSupermemoryResult } = require('./utils/supermemory');
            const body = await readJsonBody(req);
            const query = String(body.query || '').trim();
            if (!query) return sendError(res, new Error('query is required'), 400);
            const settings = getSupermemorySettings();
            if (!settings.configured) {
                return sendJson(res, {
                    configured: false,
                    baseUrl: settings.baseUrl,
                    results: [],
                    error: 'Supermemory is not configured. Set SUPERMEMORY_API_KEY in .env or save a key in the August Brain tab.'
                });
            }
            const data = await searchSupermemory({ query, limit: 5 });
            const results = (data.results || data.data || []).slice(0, 5).map(item => ({
                id: item.id,
                text: summarizeSupermemoryResult(item),
                similarity: item.similarity,
                updatedAt: item.updatedAt,
                metadata: item.metadata || null
            }));
            return sendJson(res, {
                configured: true,
                baseUrl: settings.baseUrl,
                count: results.length,
                results,
                rawTotal: data.total
            });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url === '/ui/semantic-memory' && req.method === 'DELETE') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const { deleteFact } = require('./utils/semantic-memory');
            const { key } = JSON.parse(body);
            if (!key) return sendError(res, new Error('key is required'), 400);
            const deleted = deleteFact(key);
            return sendJson(res, { deleted });
        });
        return;
    }

    if (req.url === '/ui/test' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            const testData = JSON.parse(body);
            const profile = testData.profile === 'claude' ? 'claude' : 'codex';
            const reqId = startRequest({ clientType: profile, endpoint: '/ui/test', model: testData.model || 'unknown' });
            try {
                const response = await fetch(testData.targetUrl, {
                    method: 'POST',
                    headers: buildTestHeaders(profile, testData.apiKey),
                    body: JSON.stringify(buildTestPayload(profile, testData.model)),
                    signal: AbortSignal.timeout(30000)
                });
                const text = await response.text();
                if (!response.ok) throw new Error(`HTTP ${response.status} at ${testData.targetUrl}: ${text}`);
                let data = JSON.parse(text);
                if (data.data && data.data.choices) data = data.data;
                const usage = data.usage || {};
                const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
                const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
                const choice = data.choices?.[0];
                const contentBlock = Array.isArray(data.content) ? data.content.find(part => part.type === 'text') : null;
                const content = contentBlock?.text || choice?.message?.content || choice?.message?.reasoning || 'No content returned';
                endRequest(reqId, { status: 'success', model: testData.model, inputTokens, outputTokens });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, content }));
            } catch (e) {
                endRequest(reqId, { status: 'error', model: testData.model, error: e.message });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/ui/custom-models' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { baseUrl, apiKey } = JSON.parse(body);
                if (!baseUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Base URL is required' }));
                }
                const fetchUrl = buildModelsUrl(baseUrl);
                console.log(`[Custom Provider]: Fetching models from ${fetchUrl}`);
                const fetchRes = await fetch(fetchUrl, {
                    headers: buildAuthHeaders(apiKey),
                    signal: AbortSignal.timeout(15000)
                });
                const raw = await fetchRes.text();
                if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status} at ${fetchUrl}: ${raw}`);
                const data = JSON.parse(raw);
                const models = (data.data || []).map(m => ({
                    id: m.id,
                    name: `[Custom] ${m.id}`,
                    provider: 'Custom',
                    url: fetchUrl,
                    base: normalizeOpenAIBaseUrl(baseUrl)
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(models));
            } catch (e) {
                console.error('[Custom Provider]: Fetch failed:', e.message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/ui/custom-test' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            const parsed = JSON.parse(body);
            const resolvedProfile = parsed.profile === 'claude' ? 'claude' : 'codex';
            const reqId = startRequest({ clientType: resolvedProfile, endpoint: '/ui/custom-test', model: parsed.model || 'unknown' });
            try {
                const targetUrl = buildTargetUrlForProfile(resolvedProfile, parsed.baseUrl);
                if (!targetUrl) throw new Error('Base URL is required');
                if (!parsed.model) throw new Error('Select a model first or click Fetch Models before testing');

                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers: buildTestHeaders(resolvedProfile, parsed.apiKey),
                    body: JSON.stringify(buildTestPayload(resolvedProfile, parsed.model)),
                    signal: AbortSignal.timeout(30000)
                });
                const text = await response.text();
                if (!response.ok) throw new Error(`HTTP ${response.status} at ${targetUrl}: ${text}`);
                let data = JSON.parse(text);
                if (data.data && data.data.choices) data = data.data;
                const usage = data.usage || {};
                const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
                const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
                const choice = data.choices?.[0];
                const contentBlock = Array.isArray(data.content) ? data.content.find(part => part.type === 'text') : null;
                const content = contentBlock?.text || choice?.message?.content || choice?.message?.reasoning || 'No content returned';
                endRequest(reqId, { status: 'success', model: parsed.model, inputTokens, outputTokens });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, content }));
            } catch (e) {
                endRequest(reqId, { status: 'error', model: parsed.model, error: e.message });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // ── Bookmarked Custom Providers ──
    if (req.url === '/ui/bookmarks' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getBookmarks()));
    }

    if (req.url === '/ui/bookmarks' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { name, baseUrl, apiKey, inputCostPer1M, outputCostPer1M } = JSON.parse(body);
                if (!name || !baseUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Name and baseUrl are required' }));
                }
                saveBookmark(name, baseUrl, apiKey || '', inputCostPer1M, outputCostPer1M);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, bookmarks: getBookmarks() }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url.startsWith('/ui/bookmarks/') && req.method === 'DELETE') {
        const name = decodeURIComponent(req.url.split('/').pop());
        const removed = deleteBookmark(name);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: removed, bookmarks: getBookmarks() }));
    }

    // ── Web Search (DuckDuckGo) ──
    if (req.url.startsWith('/search') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const query = url.searchParams.get('q');
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing q parameter' }));
        }
            try {
            // Delegate to the same robust HTML scraper used by the managed tool loop.
            // Previously used api.duckduckgo.com which only returns Instant Answers,
            // not real web-page search results.
            const searchResult = await executeManagedWebTool('web_search', { query, max_results: 10 });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(searchResult));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // ── Web Fetch (generic URL) ──
    if (req.url.startsWith('/fetch') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing url parameter' }));
        }
        try {
            const parsed = new URL(targetUrl);
            // Block internal addresses
            const blocked = [
                /^http:\/\/localhost/i, /^https?:\/\/127\./i,
                /^https?:\/\/10\./i, /^https?:\/\/192\.168\./i,
                /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./i,
                /^https?:\/\/0\./i, /^https?:\/\/\//i
            ];
            if (blocked.some(p => p.test(targetUrl))) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Access to internal/network addresses is not permitted' }));
            }
            const protocol = parsed.protocol === 'https:' ? https : http;
                    let fetchDone = false; // guard: exactly one of end/error/timeout may respond

            const proxyReq = protocol.get(targetUrl, {
                headers: { 'User-Agent': 'ClaudishProxy/1.0', 'Accept': '*/*' }
            }, function(proxyRes) {
                let data = '';
                proxyRes.on('data', function(chunk) { data += chunk; });
                proxyRes.on('end', function() {
                    if (fetchDone) return;
                    fetchDone = true;
                    if (data.length > 500000) data = data.substring(0, 500000) + '\n\n[Output truncated]';
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: proxyRes.statusCode,
                        headers: proxyRes.headers,
                        contentType: proxyRes.headers['content-type'] || '',
                        body: data
                    }));
                });
            });
            proxyReq.on('error', function(e) {
                if (fetchDone) return; // timeout already replied
                fetchDone = true;
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            });
            proxyReq.setTimeout(15000, function() {
                if (fetchDone) return;
                fetchDone = true;
                proxyReq.destroy(); // safe — error handler is now guarded
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request timed out after 15s' }));
            });
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid URL: ' + e.message }));
        }
        return;
    }

    // ── Fake model list (shared) ──
    if (cleanPath.includes('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const now = Math.floor(Date.now() / 1000);
        return res.end(JSON.stringify({
            object: "list",
            data: [
                { id: 'claude-opus-4-7', object: 'model', created: now, owned_by: 'claudish' },
                { id: 'claude-opus-4-6', object: 'model', created: now, owned_by: 'claudish' },
                { id: 'claude-sonnet-4-6', object: 'model', created: now, owned_by: 'claudish' },
                { id: 'gpt-5.4', object: 'model', created: now, owned_by: 'claudish' },
                { id: 'gpt-4o', object: 'model', created: now, owned_by: 'claudish' },
                { id: 'gpt-4-turbo', object: 'model', created: now, owned_by: 'claudish' }
            ]
        }));
    }

    // ── August Core Security Gateway ──
    if (cleanPath.startsWith('/v1/')) {
        // Start request logging immediately so it shows up in the UI even if blocked
        let clientType = 'unknown';
        if (cleanPath.includes('/chat/completions') || cleanPath.includes('/responses')) clientType = 'codex';
        else if (cleanPath.includes('/messages')) clientType = 'claude';
        
        const reqId = startRequest({ clientType, endpoint: cleanPath });
        
        const config = getConfig();
        const expectedKey = config.august_secret_key || 'august-core-key';
        
        const authHeader = req.headers['authorization'] || '';
        const xApiKey = req.headers['x-api-key'] || '';
        const xAugustKey = req.headers['x-august-key'] || '';
        
        const providedKey = (xAugustKey) || (xApiKey) || (authHeader.replace('Bearer ', '').trim());
        
        // Auto-bypass for Docker local networks (172.x) and localhost (127.x, ::1)
        const ip = req.socket.remoteAddress || '';
        const isLocal = ip.includes('127.0.0.1') || ip === '::1' || ip.startsWith('172.') || ip.startsWith('::ffff:172.') || ip.startsWith('192.168.');
        
        if (providedKey !== expectedKey && !isLocal) {
            console.warn(`[Security Alert]: Blocked unauthorized access attempt to ${cleanPath} from IP ${ip}`);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Unauthorized: Invalid August Core Security Key' }}));
            return endRequest(reqId, { status: 'error', error: 'Blocked by Security Gateway (Invalid Key)' });
        }
        
        // Attach client identity to request for downstream use
        const clientId = identifyClient(req);
        req.augustClientId = clientId;

        // If passed, route to the correct handler
        if (cleanPath.includes('/v1/messages/count_tokens')) {
            return anthropicAdapter.handleCountTokens(req, res, cleanPath, reqId);
        }
        if (clientType === 'codex') {
            return openaiAdapter.handleChatCompletions(req, res, cleanPath, reqId);
        }
        if (clientType === 'claude') {
            return anthropicAdapter.handleMessages(req, res, cleanPath, reqId);
        }
    }

    // Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

console.log(`--- AI Adapter Active on Port ${LISTEN_PORT} ---`);

server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log('[bridge] Server is listening...');
});

server.on('upgrade', (req, socket, head) => {
    if (terminalService.handleTerminalUpgrade(req, socket, head)) return;
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
});

setInterval(() => {
    automationJobs.runDueAutomations().catch(e => {
        console.warn('[automations] tick failed:', e.message);
    });
}, 60000).unref();

// Initialize MCP servers after the HTTP listener is available so the dashboard
// remains reachable while uvx/npx tools warm their package caches.
const claudeProfile = getProfile('claude');
startMcpServers(claudeProfile?.apiKey || '').catch(e => {
    console.error('[bridge] Failed to start MCP servers:', e);
});



