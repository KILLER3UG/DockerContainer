const http = require('http');
const fs = require('fs');
const path = require('path');
const { getConfig, saveConfig, getProfile, saveProfile, getBookmarks, saveBookmark, deleteBookmark } = require('./utils/config');
const { getActivityLog, startRequest, endRequest, getRequestLog, getPendingRequests, getRequestDetails, getRequestDetail } = require('./utils/logger');
const anthropicAdapter = require('./adapters/anthropic');
const openaiAdapter = require('./adapters/openai');

const UI_PATH = path.join(__dirname, 'ui.html');

const server = http.createServer((req, res) => {
    // ── URL normalization ──
    const originalUrl = req.url;
    let cleanPath = originalUrl
        .replace(/^\/v1\/v1\//, '/v1/')
        .replace(/^\/v1\/messages/, '/v1/messages');

    if (originalUrl.includes('/v1/')) {
        console.log(`[Proxy Incoming]: ${req.method} ${originalUrl} -> Normalized: ${cleanPath}`);
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

    if (req.url === '/ui/activity' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getActivityLog()));
    }

    if (req.url === '/ui/requests' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            pending: getPendingRequests(),
            completed: getRequestLog()
        }));
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
                if (data.contextWindow) profileData.contextWindow = parseInt(data.contextWindow, 10);
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

    if (req.url === '/ui/details' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getRequestDetails()));
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
            const uniqueModels = Array.from(new Map(allModels.map(m => [m.name, m])).values());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(uniqueModels));
        });
        return;
    }

    if (req.url === '/ui/test' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            const testData = JSON.parse(body);
            try {
                const response = await fetch(testData.targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${testData.apiKey}`
                    },
                    body: JSON.stringify({
                        model: testData.model,
                        messages: [{ role: 'user', content: 'respond with only the word "WORKING"' }]
                    }),
                    signal: AbortSignal.timeout(30000)
                });
                const text = await response.text();
                if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
                let data = JSON.parse(text);
                if (data.data && data.data.choices) data = data.data;
                const choice = data.choices?.[0];
                const content = choice?.message?.content || choice?.message?.reasoning || 'No content returned';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, content }));
            } catch (e) {
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
                // Normalize baseUrl
                let normalized = baseUrl.trim();
                if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
                if (!normalized.includes('/v1')) normalized += '/v1';

                const fetchUrl = `${normalized}/models`;
                console.log(`[Custom Provider]: Fetching models from ${fetchUrl}`);
                const fetchRes = await fetch(fetchUrl, {
                    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
                    signal: AbortSignal.timeout(15000)
                });
                if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
                const data = await fetchRes.json();
                const models = (data.data || []).map(m => ({
                    id: m.id,
                    name: `[Custom] ${m.id}`,
                    provider: 'Custom',
                    url: `${normalized}/chat/completions`,
                    base: normalized,
                    key: apiKey || ''
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
            try {
                const { baseUrl, apiKey, model } = JSON.parse(body);
                let normalized = (baseUrl || '').trim();
                if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
                if (!normalized.includes('/v1')) normalized += '/v1';
                const targetUrl = `${normalized}/chat/completions`;

                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: model || 'default',
                        messages: [{ role: 'user', content: 'respond with only the word "WORKING"' }]
                    }),
                    signal: AbortSignal.timeout(30000)
                });
                const text = await response.text();
                if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
                let data = JSON.parse(text);
                if (data.data && data.data.choices) data = data.data;
                const choice = data.choices?.[0];
                const content = choice?.message?.content || choice?.message?.reasoning || 'No content returned';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, content }));
            } catch (e) {
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
                const { name, baseUrl, apiKey } = JSON.parse(body);
                if (!name || !baseUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Name and baseUrl are required' }));
                }
                saveBookmark(name, baseUrl, apiKey || '');
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

    // ── Fake model list (shared) ──
    if (cleanPath.includes('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            data: [
                { id: 'claude-sonnet-4-6' },
                { id: 'gpt-5.4' },
                { id: 'gpt-5.5' },
                { id: 'gpt-4o' }
            ]
        }));
    }

    // ── Provider-specific adapters ──
    if (cleanPath.includes('/v1/chat/completions') || cleanPath.includes('/v1/responses')) {
        const reqId = startRequest({ clientType: 'codex', endpoint: cleanPath });
        res.on('finish', () => {
            const cfg = getProfile('codex');
            endRequest(reqId, { status: res.statusCode >= 400 ? 'error' : 'success', model: cfg.currentModel });
        });
        return openaiAdapter.handleChatCompletions(req, res, cleanPath, reqId);
    }

    if (cleanPath.includes('/v1/messages')) {
        const reqId = startRequest({ clientType: 'claude', endpoint: cleanPath });
        res.on('finish', () => {
            const cfg = getProfile('claude');
            endRequest(reqId, { status: res.statusCode >= 400 ? 'error' : 'success', model: cfg.currentModel });
        });
        return anthropicAdapter.handleMessages(req, res, cleanPath, reqId);
    }

    // Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

console.log('--- AI Adapter Active on Port 8080 ---');
server.listen(8080, '0.0.0.0');
