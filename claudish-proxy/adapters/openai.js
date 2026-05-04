const { getProfile } = require('../utils/config');
const { logActivity, endRequest, captureRequest, captureResponse, captureTokens, captureError } = require('../utils/logger');
const { applySelfHealToMessages } = require('../utils/selfheal');
const { getModelContextWindow, saveModelContextWindow, loadModelContextWindow } = require('../utils/models');
const { estimateTokens, formatTokenCount } = require('../utils/tokens');
const { buildFriendlyRateLimitMessage, getRetryDelayMs, isRetryableStatus } = require('../utils/upstream');

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

    // Normalize tool_calls: remove index field
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

// ── Translate Responses API content parts to plain text ──
function translateResponsesContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    const texts = [];
    content.forEach(part => {
        if (part.type === 'input_text' || part.type === 'output_text') {
            texts.push(part.text);
        } else if (part.type === 'input_image' || part.type === 'input_file') {
            texts.push(`[${part.type}]`);
        } else if (part.text) {
            texts.push(part.text);
        }
    });
    return texts.join('\n');
}

// ── Translate Responses API input → Chat Completions messages ──
function translateResponsesInput(oReq) {
    if (oReq.messages && Array.isArray(oReq.messages)) return; // Already Chat Completions format
    if (!oReq.input) return;

    const messages = [];

    // Instructions = system prompt in Responses API
    if (oReq.instructions) {
        messages.push({ role: 'system', content: oReq.instructions });
    }

    const input = oReq.input;
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
        // Responses API input items can be interleaved function_call / function_call_output
        // We need to group function_call items into assistant messages with tool_calls
        let pendingToolCalls = [];

        function flushToolCalls() {
            if (pendingToolCalls.length > 0) {
                messages.push({ role: 'assistant', content: '', tool_calls: pendingToolCalls });
                pendingToolCalls = [];
            }
        }

        input.forEach(item => {
            if (typeof item === 'string') {
                flushToolCalls();
                messages.push({ role: 'user', content: item });
            } else if (item.type === 'function_call') {
                pendingToolCalls.push({
                    id: item.call_id || item.id,
                    type: 'function',
                    function: {
                        name: item.name,
                        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
                    }
                });
            } else if (item.type === 'function_call_output') {
                flushToolCalls(); // MUST create assistant message with tool_calls BEFORE the tool result
                messages.push({
                    role: 'tool',
                    tool_call_id: item.call_id,
                    content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
                });
            } else if (item.role) {
                flushToolCalls();
                messages.push({
                    role: item.role,
                    content: translateResponsesContent(item.content)
                });
            }
        });

        flushToolCalls(); // Flush remaining at end
    }

    oReq.messages = messages;
}

function extractUsageTokens(usage, contextLabel) {
    const inputTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
    const outputTokens = usage?.completion_tokens || usage?.output_tokens || 0;
    if (!usage) {
        console.warn(`[Proxy Usage]: ${contextLabel} returned no usage data`);
    } else if (inputTokens === 0 && outputTokens === 0) {
        console.warn(`[Proxy Usage]: ${contextLabel} usage payload had zero tokens`);
    }
    return { inputTokens, outputTokens };
}

// ── Main handler for /v1/chat/completions and /v1/responses ──
async function handleChatCompletions(req, res, cleanPath, reqId) {
    let body = '';
    let bodyComplete = false;

    const bodyTimeout = setTimeout(() => {
        if (!bodyComplete) {
            console.error(`[Proxy Timeout]: Body parsing timed out for ${cleanPath}`);
            res.writeHead(408);
            res.end('Request Timeout');
        }
    }, 30000);

    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        bodyComplete = true;
        clearTimeout(bodyTimeout);

        // ── Per-request tracking — endRequest must fire exactly once ──
        let requestModel = 'unknown';
        let requestStatus = 'success';
        let requestError = null;
        let _endCalled = false;
        function finishRequest() {
            if (_endCalled) return;
            _endCalled = true;
            endRequest(reqId, {
                status: requestStatus,
                model: requestModel,
                error: requestError
                // tokens are read automatically from requestDetails by endRequest
            });
        }

        try {
            console.log(`[Proxy Body]: ${cleanPath} (${body.length} bytes)`);

            const cfg = getProfile('codex');
            let oReq = {};
            try {
                oReq = JSON.parse(body || '{}');
            } catch (e) {
                console.error('[Proxy Error]: Failed to parse request body:', e.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
            }

            // Capture request for debug UI
            captureRequest(reqId, { ...oReq, model: cfg.currentModel, endpoint: cleanPath });

            // Translate Responses API input format (if present) to Chat Completions messages
            translateResponsesInput(oReq);

            if (!oReq.messages || !Array.isArray(oReq.messages)) {
                oReq.messages = [{ role: 'user', content: 'hi' }];
            }

            // Inject Windows environment system prompt
            const windowsSystemPrompt = 'ENVIRONMENT: You are running on Windows (PowerShell). Use Windows commands and paths.\n' +
                '- Use PowerShell syntax (e.g., Get-ChildItem, Select-String, Test-Path) NOT bash (ls, grep, cat).\n' +
                '- Use backslash paths (C:\\Users\\...) NOT forward slash (/home/...).\n' +
                '- Use Invoke-WebRequest or curl.exe for HTTP requests.\n' +
                '- File separators are backslashes. Directory separator is backslash.\n' +
                '- Do NOT suggest bash, sh, zsh, or WSL commands unless explicitly asked.\n' +
                '- If you need to run shell commands, use PowerShell syntax.';
            const existingSystemIdx = oReq.messages.findIndex(m => m.role === 'system');
            if (existingSystemIdx >= 0) {
                const existing = oReq.messages[existingSystemIdx].content || '';
                const combined = windowsSystemPrompt + '\n\n' + existing;
                if (combined.length > 8000) {
                    console.warn(`[Proxy System Prompt]: Codex system prompt is ${combined.length} chars — may be truncated by upstream model.`);
                } else {
                    console.log(`[Proxy System Prompt]: Codex system prompt length=${combined.length} chars`);
                }
                oReq.messages[existingSystemIdx].content = combined;
            } else {
                console.log(`[Proxy System Prompt]: Codex system prompt length=${windowsSystemPrompt.length} chars (injected)`);
                oReq.messages.unshift({ role: 'system', content: windowsSystemPrompt });
            }

            // ── Dynamic model hijacking (Ollama-style) ──
            requestModel = cfg.currentModel || oReq.model;
            const authHeader = req.headers['authorization'] || '';
            if (authHeader.includes('Bearer model:')) {
                const extractedModel = authHeader.split('model:')[1].trim();
                if (extractedModel) {
                    requestModel = extractedModel;
                    console.log(`[Proxy Hijack]: Using model from CLI: ${requestModel}`);
                }
            }
            oReq.model = requestModel;

            // ── Smart context compaction (only when approaching model's limit) ──
            let contextWindow = loadModelContextWindow('codex', requestModel);
            if (!contextWindow) {
                const modelInfo = await getModelContextWindow(requestModel, cfg.targetUrl, cfg.apiKey);
                contextWindow = modelInfo.inputTokens;
                saveModelContextWindow('codex', requestModel, contextWindow);
            }
            const threshold = Math.floor(contextWindow * 0.88); // 88% threshold
            const estimatedTokens = estimateTokens(oReq.messages, oReq.tools);
            console.log(`[Proxy Context]: model=${requestModel}, window=${formatTokenCount(contextWindow)}, estimated=${formatTokenCount(estimatedTokens)}, threshold=${formatTokenCount(threshold)}`);

            if (estimatedTokens > threshold) {
                console.log(`[Proxy Compaction]: ${formatTokenCount(estimatedTokens)} tokens exceeds ${formatTokenCount(threshold)} threshold. Compacting...`);
                const systemMsgs = oReq.messages.filter(m => m.role === 'system');
                const otherMsgs = oReq.messages.filter(m => m.role !== 'system');
                let kept = otherMsgs;
                // Drop oldest non-system messages until we're under threshold
                while (kept.length > 1) {
                    const testMessages = [...systemMsgs, ...kept];
                    const testTokens = estimateTokens(testMessages, oReq.tools);
                    if (testTokens <= threshold) break;
                    kept = kept.slice(1);
                }
                oReq.messages = [...systemMsgs, ...kept];
                const newEstimate = estimateTokens(oReq.messages, oReq.tools);
                console.log(`[Proxy Compaction]: Trimmed from ${otherMsgs.length} to ${kept.length} non-system messages. New estimate: ${formatTokenCount(newEstimate)}`);

                // If still over threshold, truncate individual long messages
                if (newEstimate > threshold) {
                    oReq.messages.forEach(m => {
                        if (typeof m.content === 'string' && m.content.length > 8000) {
                            m.content = m.content.substring(0, 8000) + '\n\n[TRUNCATED]';
                        }
                    });
                    const finalEstimate = estimateTokens(oReq.messages, oReq.tools);
                    console.log(`[Proxy Compaction]: Also truncated long messages. Final estimate: ${formatTokenCount(finalEstimate)}`);
                }
                logActivity('COMPACT', `Codex: ${formatTokenCount(estimatedTokens)} -> ${formatTokenCount(estimateTokens(oReq.messages, oReq.tools))} tokens (${formatTokenCount(contextWindow)} window)`);
            }

            // Self-healing: enhance error tool results so the model can fix them
            oReq.messages = applySelfHealToMessages(oReq.messages);

            logActivity('AGENT', `Request using ${oReq.model}`);
            console.log(`[Proxy Upstream]: Sending request to ${cfg.targetUrl} for model ${oReq.model}`);

            // Codex Responses API expects Responses-format SSE, but upstream speaks Chat Completions.
            // Force non-streaming upstream so we can translate JSON -> Responses SSE.
            const isResponsesEndpoint = cleanPath.includes('/v1/responses');
            const clientWantsStream = oReq.stream === true; // Default to non-streaming
            // Free-tier models default to tiny limits (~256 tokens). Ensure a reasonable minimum.
            // This applies to BOTH Responses API and Chat Completions paths.
            const clientMaxTokens = oReq.max_output_tokens !== undefined ? oReq.max_output_tokens : oReq.max_tokens;
            const effectiveMaxTokens = Math.max(1024, Math.min(clientMaxTokens || 2048, 65536));
            oReq.max_tokens = effectiveMaxTokens;
            delete oReq.max_output_tokens;

            if (isResponsesEndpoint) {
                oReq.stream = false;
                // Clean up Responses-only fields that upstream won't understand
                delete oReq.previous_response_id;
                delete oReq.input;
                delete oReq.instructions;
                // Pass through standard params (temperature, top_p, stop, etc. are already compatible)
                console.log(`[Proxy Params]: max_tokens=${oReq.max_tokens}, temp=${oReq.temperature}, top_p=${oReq.top_p}`);
            }

            let response;
            let attempts = 0;
            const maxAttempts = 3;
            while (attempts < maxAttempts) {
                attempts++;
                response = await fetch(cfg.targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${cfg.apiKey}`
                    },
                    body: JSON.stringify(oReq),
                    signal: AbortSignal.timeout(300000)
                });
                if (!isRetryableStatus(response.status) || attempts >= maxAttempts) {
                    break;
                }
                const delayMs = getRetryDelayMs(response, attempts);
                console.warn(`[Proxy Retry]: OpenAI upstream returned ${response.status}. Retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }

            console.log(`[Proxy Upstream]: Received status ${response.status}`);

            const upstreamIsStream = response.headers.get('content-type')?.includes('text/event-stream');

            // ── /v1/responses translation (OpenAI Responses API) ──
            if (isResponsesEndpoint) {
                const rawBody = await response.text();
                if (!response.ok) {
                    if (response.status === 429) {
                        requestStatus = 'error';
                        requestError = buildFriendlyRateLimitMessage(response.status, rawBody, attempts);
                    }
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    return res.end(response.status === 429 ? JSON.stringify({
                        type: 'error',
                        error: {
                            type: 'rate_limit_error',
                            message: requestError
                        }
                    }) : rawBody);
                }
                try {
                    const standardData = upstreamIsStream ? parseSSEToJSON(rawBody) : JSON.parse(rawBody);
                    captureResponse(reqId, standardData);
                    const choice = standardData.choices?.[0];
                    const finishReason = choice?.finish_reason || 'N/A';
                    const contentLen = choice?.message?.content?.length || 0;
                    const toolCallCount = choice?.message?.tool_calls?.length || 0;
                    console.log(`[Proxy Upstream]: finish_reason="${finishReason}", content_len=${contentLen}, tool_calls=${toolCallCount}`);
                    // Warn if model stopped due to token limit — this is the #1 cause of incomplete responses
                    if (finishReason === 'length') {
                        console.warn(`[Proxy WARNING]: Upstream stopped due to max_tokens limit! Response was truncated. Consider using a model with larger output capacity.`);
                    }
                    const respId = 'resp_' + Math.random().toString(36).substr(2, 9);
                    const createdAt = Math.floor(Date.now() / 1000);
                    const chatUsage = standardData.usage || {};
                    const usage = {
                        input_tokens: chatUsage.prompt_tokens || 0,
                        output_tokens: chatUsage.completion_tokens || 0,
                        total_tokens: chatUsage.total_tokens || (chatUsage.prompt_tokens || 0) + (chatUsage.completion_tokens || 0)
                    };
                    // Record tokens in the log immediately (no global endRequest for this path)
                    captureTokens(reqId, usage.input_tokens, usage.output_tokens);

                    // Build output items
                    const outputItems = [];
                    let msgContent = '';
                    if (choice?.message) {
                        const msg = choice.message;
                        if (msg.reasoning) {
                            outputItems.push({
                                id: 'item_' + Math.random().toString(36).substr(2, 9),
                                type: 'reasoning',
                                status: 'completed',
                                content: msg.reasoning
                            });
                        }
                        if (msg.tool_calls) {
                            msg.tool_calls.forEach(tc => {
                                outputItems.push({
                                    id: tc.id,
                                    type: 'function_call',
                                    status: 'completed',
                                    name: tc.function.name,
                                    arguments: tc.function.arguments,
                                    call_id: tc.id
                                });
                            });
                        }
                        if (msg.content) {
                            msgContent = msg.content;
                            outputItems.push({
                                id: 'msg_' + Math.random().toString(36).substr(2, 9),
                                type: 'message',
                                status: 'completed',
                                role: 'assistant',
                                content: [{ type: 'output_text', text: msgContent }]
                            });
                        }
                    }

                    const baseResponse = {
                        id: respId,
                        object: 'response',
                        created_at: createdAt,
                        status: 'in_progress',
                        model: requestModel,
                        output: [],
                        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
                    };

                    const completedResponse = {
                        ...baseResponse,
                        status: 'completed',
                        output: outputItems,
                        usage: usage
                    };

                    // Simulate Responses API streaming event sequence
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

                    // 1. response.created
                    res.write(`data: ${JSON.stringify({ type: 'response.created', response: baseResponse })}\n\n`);

                    // 2. response.in_progress
                    res.write(`data: ${JSON.stringify({ type: 'response.in_progress', response: baseResponse })}\n\n`);

                    // 3. Output items added/done + text deltas
                    outputItems.forEach((item, idx) => {
                        // output_item.added
                        res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: idx, item })}\n\n`);

                        if (item.type === 'message' && item.content?.[0]?.type === 'output_text') {
                            // content_part.added
                            res.write(`data: ${JSON.stringify({ type: 'response.content_part.added', item_id: item.id, content_index: 0, part: { type: 'output_text', text: '' } })}\n\n`);

                            // Stream text in ~20 char chunks
                            const text = item.content[0].text;
                            const chunkSize = 20;
                            for (let i = 0; i < text.length; i += chunkSize) {
                                const delta = text.substring(i, i + chunkSize);
                                res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: item.id, content_index: 0, delta })}\n\n`);
                            }

                            // content_part.done
                            res.write(`data: ${JSON.stringify({ type: 'response.content_part.done', item_id: item.id, content_index: 0, part: { type: 'output_text', text: text, annotations: [] } })}\n\n`);
                        } else if (item.type === 'function_call') {
                            // Function call arguments delta (Codex expects incremental delivery)
                            const args = item.arguments || '{}';
                            const argChunkSize = 20;
                            for (let i = 0; i < args.length; i += argChunkSize) {
                                const delta = args.substring(i, i + argChunkSize);
                                res.write(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: idx, delta })}\n\n`);
                            }
                        }

                        // output_item.done
                        res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: idx, item })}\n\n`);
                    });

                    // 4. response.completed
                    res.write(`data: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`);

                    // 5. [DONE]
                    res.write('data: [DONE]\n\n');
                    res.end();
                    finishRequest();
                    return;
                } catch (transErr) {
                    requestStatus = 'error';
                    requestError = transErr.message;
                    console.error('[Proxy Translation]: FAILED', transErr.message);
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ type: 'error', error: { message: transErr.message } })}\n\n`);
                    res.end();
                    finishRequest();
                    return;
                }
            }

            // ── Streaming handling ──

            if (upstreamIsStream && clientWantsStream) {
                // Forward SSE directly; accumulate body copy to extract usage when done.
                res.writeHead(response.status, { 'Content-Type': 'text/event-stream' });
                if (!response.body) {
                    res.end();
                    finishRequest();
                } else {
                    const reader = response.body.getReader();
                    let accumulatedText = '';
                    function pump() {
                        reader.read().then(({ done, value }) => {
                            if (done) {
                                // Reconstruct full response to capture it for debug UI
                                try {
                                    const parsed = parseSSEToJSON(accumulatedText);
                                    captureResponse(reqId, parsed);
                                    const inTok  = parsed.usage?.prompt_tokens     || parsed.usage?.input_tokens     || 0;
                                    const outTok = parsed.usage?.completion_tokens || parsed.usage?.output_tokens || 0;
                                    captureTokens(reqId, inTok, outTok);
                                } catch (e) {
                                    console.warn('[Proxy SSE Parse Warning]: Failed to reconstruct OpenAI response for capture:', e.message);
                                }
                                res.end();
                                finishRequest(); // ← request is now done
                                return;
                            }
                            const chunk = Buffer.from(value);
                            accumulatedText += chunk.toString();
                            res.write(chunk);
                            pump();
                        }).catch(err => {
                            console.error('[Proxy Stream Error]:', err);
                            requestStatus = 'error';
                            requestError = err.message;
                            res.end();
                            finishRequest();
                        });
                    }
                    pump();
                    return; // finishRequest is called inside pump's done handler
                }
            } else if (!upstreamIsStream && clientWantsStream) {
                // Provider returned JSON but client expects SSE (Codex)
                const rawBody = await response.text();
                if (!response.ok) {
                    requestStatus = 'error';
                    requestError = response.status === 429
                        ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                        : `Upstream Error (${response.status}): ${rawBody}`;
                    res.writeHead(response.status, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ type: 'error', error: { message: requestError } })}\n\n`);
                    res.end();
                    return;
                }
                try {
                    const data = JSON.parse(rawBody);
                    captureResponse(reqId, data);
                    const inTok  = data.usage?.prompt_tokens     || data.usage?.input_tokens     || 0;
                    const outTok = data.usage?.completion_tokens || data.usage?.output_tokens || 0;
                    captureTokens(reqId, inTok, outTok);
                    const upstreamMsg = data.choices?.[0]?.message;
                    const delta = {
                        role: upstreamMsg?.role,
                        content: upstreamMsg?.content || ''
                    };
                    // Include tool_calls in the synthesized SSE so the client knows what tools to execute
                    if (upstreamMsg?.tool_calls && upstreamMsg.tool_calls.length > 0) {
                        delta.tool_calls = upstreamMsg.tool_calls.map((tc, idx) => ({
                            index: idx,
                            id: tc.id,
                            type: tc.type,
                            function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' }
                        }));
                    }
                    const chunk = {
                        id: data.id || 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
                        object: 'chat.completion.chunk',
                        created: data.created || Math.floor(Date.now() / 1000),
                        model: requestModel,
                        choices: [{
                            index: 0,
                            delta: delta,
                            finish_reason: data.choices?.[0]?.finish_reason || null
                        }]
                    };
                    res.writeHead(response.status, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    res.write(`data: [DONE]\n\n`);
                    res.end();
                } catch (e) {
                    requestStatus = 'error';
                    requestError = e.message;
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(rawBody);
                }
            } else if (upstreamIsStream && !clientWantsStream) {
                // Upstream returned SSE but client expects JSON — parse and aggregate
                const rawBody = await response.text();
                if (!response.ok) {
                    requestStatus = 'error';
                    requestError = response.status === 429
                        ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                        : `Upstream Error (${response.status}): ${rawBody}`;
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: requestError } }));
                    return;
                }
                try {
                    const parsed = parseSSEToJSON(rawBody);
                    captureResponse(reqId, parsed);
                    const { inputTokens: inTok, outputTokens: outTok } = extractUsageTokens(parsed.usage, 'SSE->JSON aggregation');
                    captureTokens(reqId, inTok, outTok);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(parsed));
                } catch (e) {
                    console.error('[Proxy SSE Parse Error]:', e.message);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(rawBody);
                }
            } else {
                // Non-streaming passthrough
                const rawBody = await response.text();
                if (!response.ok) {
                    requestStatus = 'error';
                    requestError = response.status === 429
                        ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                        : `Upstream Error (${response.status}): ${rawBody}`;
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: requestError } }));
                    return;
                }
                try {
                    const parsed = JSON.parse(rawBody);
                    captureResponse(reqId, parsed);
                    const { inputTokens: inTok, outputTokens: outTok } = extractUsageTokens(parsed.usage, 'JSON passthrough');
                    captureTokens(reqId, inTok, outTok);
                } catch (e) { /* ignore parse errors for passthrough */ }
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(rawBody);
            }
        } catch (e) {
            requestStatus = 'error';
            requestError = e.message;
            console.error('OpenAI Adapter Error:', e);
            captureError(reqId, e);
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Proxy Error: ' + e.message } }));
        } finally {
            finishRequest(); // no-op if already called by streaming path
        }
    });
}

module.exports = { handleChatCompletions };
