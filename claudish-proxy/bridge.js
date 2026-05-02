const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getConfig, saveConfig, getProfile, saveProfile, getBookmarks, saveBookmark, deleteBookmark } = require('./utils/config');
const { getActivityLog, startRequest, endRequest, getRequestLog, getPendingRequests, getFilteredRequests, getStats, getRequestDetails, getRequestDetail, addSSEClient, removeSSEClient } = require('./utils/logger');
const anthropicAdapter = require('./adapters/anthropic');
const openaiAdapter = require('./adapters/openai');
const { startMcpServers } = require('./utils/mcp-client');

const UI_PATH = path.join(__dirname, 'ui.html');

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
    if (profile === 'claude') {
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

    if (req.url === '/ui/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getConfig()));
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
            const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`;
            const response = await fetch(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaudishProxy/1.0)' },
                signal: AbortSignal.timeout(10000)
            });
            const data = await response.json();
            // Extract top results
            const results = (data.RelatedTopics || []).slice(0, 10).map(t => ({
                title: t.Text || '',
                url: t.FirstURL || '',
                snippet: (t.Text || '').substring(0, 200)
            })).filter(r => r.url);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                query: query,
                results: results,
                abstract: data.AbstractText || ''
            }));
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
            const proxyReq = protocol.get(targetUrl, {
                headers: { 'User-Agent': 'ClaudishProxy/1.0', 'Accept': '*/*' }
            }, function(proxyRes) {
                let data = '';
                proxyRes.on('data', function(chunk) { data += chunk; });
                proxyRes.on('end', function() {
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
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            });
            proxyReq.setTimeout(15000, function() {
                proxyReq.destroy();
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
        return res.end(JSON.stringify({
            data: [
                { id: 'claude-opus-4-7' },
                { id: 'claude-opus-4-6' },
                { id: 'claude-sonnet-4-6' },
                { id: 'gpt-4o' }
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

console.log('--- AI Adapter Active on Port 8080 ---');

// Initialize MCP Servers async (if enabled)
// Will use config key if available, or fallback to env var
const claudeProfile = getProfile('claude');
startMcpServers(claudeProfile?.apiKey || '').then(() => {
    server.listen(8080, '0.0.0.0');
    console.log('[bridge] Server is listening...');
}).catch(e => {
    console.error('[bridge] Failed to start MCP servers:', e);
    // Start anyway so proxy doesn't completely die if MCP fails
    server.listen(8080, '0.0.0.0');
});
