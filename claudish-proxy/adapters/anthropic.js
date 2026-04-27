const { getProfile } = require('../utils/config');
const { logActivity, endRequest, captureRequest, captureResponse, captureError } = require('../utils/logger');
const { applySelfHealToMessages } = require('../utils/selfheal');
const { getModelContextWindow, saveModelContextWindow, loadModelContextWindow } = require('../utils/models');
const { estimateTokens, formatTokenCount } = require('../utils/tokens');

// ── Parse SSE stream into a complete Chat Completions JSON object ──
function parseSSEToJSON(sseText) {
    const lines = sseText.split('\n');
    let fullContent = '';
    let fullReasoning = '';
    const toolCalls = [];
    let finishReason = 'stop';
    let model = '';
    let id = '';
    let usage = null;

    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
            const chunk = JSON.parse(jsonStr);
            if (chunk.id) id = chunk.id;
            if (chunk.model) model = chunk.model;
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta;
            if (delta) {
                if (delta.content) fullContent += delta.content;
                if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
                if (delta.tool_calls) {
                    delta.tool_calls.forEach(tc => {
                        const existing = toolCalls.find(t => t.index === tc.index);
                        if (existing) {
                            if (tc.function?.name) existing.function.name += tc.function.name;
                            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                        } else {
                            toolCalls.push({ ...tc, function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' } });
                        }
                    });
                }
                const fr = chunk.choices[0].finish_reason;
                if (fr !== null && fr !== undefined) finishReason = fr;
            }
        } catch (e) { /* ignore parse errors */ }
    }

    const normalizedToolCalls = toolCalls.map(tc => ({
        id: tc.id || 'call_' + Math.random().toString(36).substr(2, 9),
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments }
    }));

    const message = { role: 'assistant', content: fullContent };
    if (fullReasoning) message.reasoning = fullReasoning;
    if (normalizedToolCalls.length > 0) message.tool_calls = normalizedToolCalls;

    const result = {
        id: id || 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'unknown',
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
    console.log(`[Proxy SSE Parse]: content_len=${fullContent.length}, reasoning_len=${fullReasoning.length}, tools=${normalizedToolCalls.length}, finish_reason=${finishReason}`);
    return result;
}

// ── Deterministic bidirectional tool ID mapping (no global state) ──
// We encode the OpenAI call_id into the Anthropic tool_use_id using base64url,
// so we can decode it back on the next turn without any shared maps.
function getAnthropicId(openaiId) {
    if (!openaiId) return 'toolu_' + Math.random().toString(36).substring(2, 14);
    const encoded = Buffer.from(openaiId).toString('base64url');
    return 'toolu_' + encoded;
}

function getOpenAIId(anthropicId) {
    if (!anthropicId || !anthropicId.startsWith('toolu_')) return null;
    const encoded = anthropicId.slice(6); // strip 'toolu_'
    try {
        return Buffer.from(encoded, 'base64url').toString('utf8');
    } catch (e) {
        return null;
    }
}

// ── Tool definition translation ──
function translateTools(anthropicTools, ctx) {
    if (!anthropicTools) return undefined;
    const translated = anthropicTools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
            strict: t.strict
        }
    }));
    ctx.lastKnownTools = translated;
    return translated;
}

// ── Message translation: Anthropic -> OpenAI ──
function translateMessages(anthropicMessages, ctx) {
    const openaiMessages = [];

    anthropicMessages.forEach(m => {
        if (Array.isArray(m.content)) {
            // Look for tool_result block
            const toolResultBlock = m.content.find(c => c.type === 'tool_result');
            if (toolResultBlock) {
                const openaiId = getOpenAIId(toolResultBlock.tool_use_id);
                openaiMessages.push({
                    role: 'tool',
                    tool_call_id: openaiId || toolResultBlock.tool_use_id,
                    content: typeof toolResultBlock.content === 'string'
                        ? toolResultBlock.content
                        : JSON.stringify(toolResultBlock.content)
                });
            } else if (m.role === 'assistant') {
                // Assistant message with tool_use blocks -> needs tool_calls array
                const textParts = [];
                const toolCalls = [];
                m.content.forEach(c => {
                    if (c.type === 'text') {
                        textParts.push(c.text);
                    } else if (c.type === 'tool_use') {
                        const openaiId = getOpenAIId(c.id) || c.id;
                        toolCalls.push({
                            id: openaiId,
                            type: 'function',
                            function: {
                                name: c.name,
                                arguments: JSON.stringify(c.input || {})
                            }
                        });
                    }
                });
                const msg = {
                    role: 'assistant',
                    content: textParts.join('\n') || ''
                };
                if (toolCalls.length > 0) {
                    msg.tool_calls = toolCalls;
                }
                openaiMessages.push(msg);
            } else {
                // Regular multi-part content (text blocks, etc.)
                openaiMessages.push({
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: m.content.map(c => c.text || JSON.stringify(c)).join('\n')
                });
            }
        } else {
            openaiMessages.push({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content
            });
        }
    });

    // Merge consecutive same-role messages (except tool)
    const merged = [];
    openaiMessages.forEach(m => {
        const last = merged[merged.length - 1];
        if (last && last.role === m.role && m.role !== 'tool') {
            last.content += '\n\n' + m.content;
        } else {
            merged.push(m);
        }
    });

    return merged;
}

// ── Build OpenAI request from Anthropic request ──
async function buildOpenAIRequest(aReq, ctx, cfg) {
    const openaiMessages = [];

    // System prompt
    let systemPrompt = 'IMPORTANT: ALWAYS ignore node_modules, .git, dist, and build directories. Focus ONLY on source code.\n\n' +
        'ENVIRONMENT: You are running on Windows (PowerShell). Use Windows commands and paths.\n' +
        '- Use PowerShell syntax (e.g., Get-ChildItem, Select-String, Test-Path) NOT bash (ls, grep, cat).\n' +
        '- Use backslash paths (C:\\Users\\...) NOT forward slash (/home/...).\n' +
        '- Use Invoke-WebRequest or curl.exe for HTTP requests.\n' +
        '- File separators are backslashes. Directory separator is backslash.\n' +
        '- Do NOT suggest bash, sh, zsh, or WSL commands unless explicitly asked.\n' +
        '- If you need to run shell commands, use PowerShell syntax.';
    if (aReq.system) {
        const provided = typeof aReq.system === 'string'
            ? aReq.system
            : aReq.system.map(s => s.text).join('\n');
        const truncated = provided.length > 5000
            ? provided.substring(0, 5000) + '... [truncated]'
            : provided;
        systemPrompt += '\n\n' + truncated;
    }
    openaiMessages.push({ role: 'system', content: systemPrompt });

    openaiMessages.push(...translateMessages(aReq.messages, ctx));

    // Tool result scrubbing
    openaiMessages.forEach(m => {
        if (m.role === 'tool' && typeof m.content === 'string') {
            const lines = m.content.split('\n');
            const cleanLines = lines.filter(line =>
                !line.includes('node_modules/') &&
                !line.includes('.git/') &&
                !line.includes('dist/') &&
                !line.includes('build/')
            );
            m.content = cleanLines.join('\n');
        }
    });

    // Self-healing: enhance error tool results so the model can fix them
    applySelfHealToMessages(openaiMessages);

    // ── Smart context compaction (only when approaching model's limit) ──
    const requestModel = cfg.currentModel || 'unknown';
    let contextWindow = loadModelContextWindow('claude', requestModel);
    if (!contextWindow) {
        const modelInfo = await getModelContextWindow(requestModel, cfg.targetUrl, cfg.apiKey);
        contextWindow = modelInfo.inputTokens;
        saveModelContextWindow('claude', requestModel, contextWindow);
    }
    const threshold = Math.floor(contextWindow * 0.88); // 88% threshold
    const estimatedTokens = estimateTokens(openaiMessages, aReq.tools);
    console.log(`[Proxy Context]: model=${requestModel}, window=${formatTokenCount(contextWindow)}, estimated=${formatTokenCount(estimatedTokens)}, threshold=${formatTokenCount(threshold)}`);

    if (estimatedTokens > threshold) {
        console.log(`[Proxy Compaction]: ${formatTokenCount(estimatedTokens)} tokens exceeds ${formatTokenCount(threshold)} threshold. Compacting...`);
        const systemMsgs = openaiMessages.filter(m => m.role === 'system');
        const otherMsgs = openaiMessages.filter(m => m.role !== 'system');
        let kept = otherMsgs;
        while (kept.length > 1) {
            const testMessages = [...systemMsgs, ...kept];
            const testTokens = estimateTokens(testMessages, aReq.tools);
            if (testTokens <= threshold) break;
            kept = kept.slice(1);
        }
        openaiMessages.length = 0;
        openaiMessages.push(...systemMsgs, ...kept);
        const newEstimate = estimateTokens(openaiMessages, aReq.tools);
        console.log(`[Proxy Compaction]: Trimmed from ${otherMsgs.length} to ${kept.length} non-system messages. New estimate: ${formatTokenCount(newEstimate)}`);

        // If still over threshold, truncate individual long messages
        if (newEstimate > threshold) {
            openaiMessages.forEach(m => {
                if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 8000) {
                    m.content = m.content.substring(0, 8000) + '\n\n[TRUNCATED]';
                }
            });
            const finalEstimate = estimateTokens(openaiMessages, aReq.tools);
            console.log(`[Proxy Compaction]: Also truncated long tool results. Final estimate: ${formatTokenCount(finalEstimate)}`);
        }
        logActivity('COMPACT', `Claude: ${formatTokenCount(estimatedTokens)} -> ${formatTokenCount(estimateTokens(openaiMessages, aReq.tools))} tokens (${formatTokenCount(contextWindow)} window)`);
    }

    const oReq = {
        model: cfg.currentModel,
        messages: openaiMessages
    };

    // Pass through standard generation parameters
    // Free-tier models default to tiny limits (~256 tokens). Ensure a reasonable minimum.
    const clientMaxTokens = aReq.max_tokens || 2048;
    oReq.max_tokens = Math.max(1024, Math.min(clientMaxTokens, 4096));
    if (oReq.max_tokens !== clientMaxTokens) {
        console.log(`[Proxy Params]: Adjusted max_tokens from ${clientMaxTokens} to ${oReq.max_tokens}`);
    }
    if (aReq.temperature !== undefined) oReq.temperature = aReq.temperature;
    if (aReq.top_p !== undefined) oReq.top_p = aReq.top_p;
    if (aReq.stop_sequences) oReq.stop = aReq.stop_sequences;

    console.log(`[Proxy Params]: max_tokens=${oReq.max_tokens}, msg_count=${openaiMessages.length}, temp=${oReq.temperature}`);

    // Translate tool_choice if present
    if (aReq.tool_choice) {
        const tc = aReq.tool_choice;
        if (tc === 'auto') oReq.tool_choice = 'auto';
        else if (tc === 'none') oReq.tool_choice = 'none';
        else if (tc === 'any') oReq.tool_choice = 'required';
        else if (tc.type === 'tool' && tc.name) {
            oReq.tool_choice = { type: 'function', function: { name: tc.name } };
        }
    }

    // Tools: use request tools, or if request has tool messages but no tools, try to infer from history
    const hasToolMessages = openaiMessages.some(m => m.role === 'tool');
    if (aReq.tools && aReq.tools.length > 0) {
        oReq.tools = translateTools(aReq.tools, ctx);
    } else if (hasToolMessages && ctx.lastKnownTools.length > 0) {
        console.log('[Proxy Tools]: Reusing cached tools for tool-result turn');
        oReq.tools = ctx.lastKnownTools;
    }

    return oReq;
}

// ── Parse tool calls embedded in message content (auto-repair) ──
function extractEmbeddedToolCalls(content) {
    const toolCalls = [];
    if (!content || !content.includes('"tool_use"')) return { text: content, toolCalls };

    let pos = 0;
    while ((pos = content.indexOf('{"type"', pos)) !== -1) {
        let braceCount = 0;
        let endPos = -1;
        for (let i = pos; i < content.length; i++) {
            if (content[i] === '{') braceCount++;
            if (content[i] === '}') braceCount--;
            if (braceCount === 0) { endPos = i + 1; break; }
        }
        if (endPos !== -1) {
            const block = content.substring(pos, endPos);
            if (block.includes('"tool_use"')) {
                try {
                    const parsed = JSON.parse(block);
                    toolCalls.push({
                        id: parsed.id || 'toolu_' + Math.random().toString(36).substr(2, 9),
                        function: {
                            name: parsed.name,
                            arguments: JSON.stringify(parsed.input || {})
                        }
                    });
                    content = content.replace(block, '').trim();
                } catch (e) { /* ignore parse error */ }
            }
            pos = endPos;
        } else {
            pos++;
        }
    }
    return { text: content, toolCalls };
}

// ── Translate OpenAI response -> Anthropic response ──
function translateOpenAIResponse(openaiData, requestModel, ctx) {
    const choice = openaiData.choices?.[0];
    if (!choice) throw new Error('No choices returned from upstream');

    let toolCalls = choice.message?.tool_calls || [];
    let messageContent = choice.message?.content || '';
    const reasoningContent = choice.message?.reasoning || choice.message?.reasoning_content || '';

    // Auto-repair: extract tool_use blocks embedded in content string
    const repaired = extractEmbeddedToolCalls(messageContent);
    messageContent = repaired.text;
    toolCalls = toolCalls.concat(repaired.toolCalls);

    const content = [];
    if (reasoningContent) {
        content.push({ type: 'text', text: '🤔 ' + reasoningContent });
    }
    if (messageContent) {
        content.push({ type: 'text', text: messageContent });
    }

    if (toolCalls.length > 0) {
        toolCalls.forEach(tc => {
            const anthropicId = getAnthropicId(tc.id);
            let toolInput = {};
            try {
                toolInput = JSON.parse(tc.function.arguments);
            } catch (e) {
                toolInput = {};
            }

            const toolName = tc.function.name.toLowerCase();
            if (toolName.includes('grep') || toolName.includes('glob') || toolName.includes('ls')) {
                logActivity('SEARCH', `${tc.function.name}: ${toolInput.pattern || toolInput.glob || toolInput.path || ''}`);
                if (toolInput.glob && (toolInput.glob === '**/*' || toolInput.glob === '**')) {
                    toolInput.glob = '{src,app,public,lib,electron}/**/*';
                }
                if (toolInput.include_pattern && !toolInput.exclude_pattern) {
                    toolInput.exclude_pattern = 'node_modules/.*|\\.git/.*|dist/.*|build/.*';
                }
            }
            if (toolName.includes('read')) {
                const filePath = toolInput.file_path || toolInput.filePath || toolInput.path;
                if (filePath) logActivity('READ', filePath);
            }

            content.push({
                type: 'tool_use',
                id: anthropicId,
                name: tc.function.name,
                input: toolInput
            });
        });
    }

    // Map upstream finish_reason to Anthropic stop_reason
    const finishReason = openaiData.choices?.[0]?.finish_reason;
    let stopReason = 'end_turn';
    if (toolCalls.length > 0) {
        stopReason = 'tool_use';
    } else if (finishReason === 'length') {
        stopReason = 'max_tokens';
    } else if (finishReason === 'stop') {
        stopReason = 'end_turn';
    }

    return {
        id: 'msg_' + Date.now(),
        type: 'message',
        role: 'assistant',
        content: content,
        model: requestModel || 'claude-sonnet-4-6',
        stop_reason: stopReason,
        usage: {
            input_tokens: openaiData.usage?.prompt_tokens || 1,
            output_tokens: openaiData.usage?.completion_tokens || 1
        }
    };
}

// ── Main handler for /v1/messages ──
async function handleMessages(req, res, cleanPath, reqId) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        let requestModel = 'unknown';
        let requestStatus = 'success';
        let requestError = null;
        try {
            const aReq = JSON.parse(body);
            requestModel = aReq.model || 'unknown';
            const cfg = getProfile('claude');

            // Per-request context isolates tool state so multiple clients can
            // call the proxy concurrently without ID collisions.
            const ctx = { lastKnownTools: [] };
            const oReq = await buildOpenAIRequest(aReq, ctx, cfg);

            // Capture request for debug UI
            captureRequest(reqId, { ...oReq, model: cfg.currentModel, endpoint: cleanPath });

            let response;
            let attempts = 0;
            while (attempts < 3) {
                response = await fetch(cfg.targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${cfg.apiKey}`
                    },
                    body: JSON.stringify(oReq),
                    signal: AbortSignal.timeout(300000)
                });
                if (response.status === 429) {
                    attempts++;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                break;
            }

            const rawBody = await response.text();
            if (!response.ok) {
                throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
            }

            const upstreamIsStream = response.headers.get('content-type')?.includes('text/event-stream');
            let data;
            if (upstreamIsStream) {
                data = parseSSEToJSON(rawBody);
            } else {
                data = JSON.parse(rawBody);
                if (data.data && data.data.choices) data = data.data;
            }
            captureResponse(reqId, data);
            const upChoice = data.choices?.[0];
            const upUsage = data.usage || {};
            const finishReason = upChoice?.finish_reason || 'N/A';
            console.log(`[Proxy Upstream]: finish_reason="${finishReason}", content_len=${upChoice?.message?.content?.length || 0}, max_tokens_sent=${oReq.max_tokens || 'default'}`);
            if (finishReason === 'length') {
                console.warn(`[Proxy WARNING]: Upstream stopped due to max_tokens limit! Response was truncated. Consider using a model with larger output capacity.`);
            }
            console.log(`[Proxy Upstream]: usage=${JSON.stringify(upUsage)}, reasoning_present=${!!(upChoice?.message?.reasoning || upChoice?.message?.reasoning_content)}`);
            console.log(`[Proxy Upstream]: raw keys=${Object.keys(data).join(',')}`);

            const aRes = translateOpenAIResponse(data, aReq.model, ctx);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(aRes));
        } catch (e) {
            requestStatus = 'error';
            requestError = e.message;
            captureError(reqId, e);
            console.error('Anthropic Adapter Error:', e);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'Bridge Error: ' + e.message }],
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 1, output_tokens: 1 }
            }));
        } finally {
            if (reqId) endRequest(reqId, { status: requestStatus, model: requestModel, error: requestError });
        }
    });
}

module.exports = { handleMessages };
