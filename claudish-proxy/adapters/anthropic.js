const { getProfile, syncClaudePublicAlias } = require('../utils/config');
const { logActivity, endRequest, captureRequest, captureResponse, captureTokens, captureError } = require('../utils/logger');
const { applySelfHealToMessages } = require('../utils/selfheal');
const { getModelContextWindow, saveModelContextWindow, loadModelContextWindow } = require('../utils/models');
const { estimateTokens, formatTokenCount } = require('../utils/tokens');
const { buildFriendlyRateLimitMessage, getRetryDelayMs, isRetryableStatus } = require('../utils/upstream');
const { getMcpToolDefinitions, isMcpToolName, executeMcpToolCall } = require('../utils/mcp-client');
const { getAugustToolDefinitions, isAugustToolName, executeAugustToolCall, readAugustCoreMemory } = require('../utils/august-tools');
const { validateToolArguments, buildValidationErrorToolMessage } = require('../utils/validator');

const CLAUDE_PUBLIC_MODEL_ALIAS = 'claude-opus-4-6';
const KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES = new Set([
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6'
]);
const DEFAULT_MINIMAX_TEMPERATURE = 1;
const DEFAULT_MINIMAX_TOP_P = 0.95;
const DEFAULT_MINIMAX_TOP_K = 40;

function isMiniMaxModel(model) {
    if (typeof model === 'string' && model.toLowerCase().includes('minimax')) {
        return true;
    }
    return false;
}

function resolvePreferredTemperature(requestedTemperature, model) {
    if (requestedTemperature !== undefined) return requestedTemperature;
    if (isMiniMaxModel(model)) return DEFAULT_MINIMAX_TEMPERATURE;
    return undefined;
}

function resolvePreferredTopP(requestedTopP, model) {
    if (requestedTopP !== undefined) return requestedTopP;
    if (isMiniMaxModel(model)) return DEFAULT_MINIMAX_TOP_P;
    return undefined;
}

function resolvePreferredTopK(requestedTopK, model, isAnthropicPath) {
    // top_k is NOT supported on the MiniMax Anthropic-compatible endpoint.
    // Sending it causes parameter validation issues. Strip it on Anthropic paths.
    if (isAnthropicPath && isMiniMaxModel(model)) return undefined;
    if (requestedTopK !== undefined) return requestedTopK;
    if (isMiniMaxModel(model)) return DEFAULT_MINIMAX_TOP_K;
    return undefined;
}

function resolveClaudePublicModelAlias(requestedModel) {
    if (typeof requestedModel !== 'string') return CLAUDE_PUBLIC_MODEL_ALIAS;
    const normalized = requestedModel.trim();
    if (!normalized) return CLAUDE_PUBLIC_MODEL_ALIAS;
    const lowered = normalized.toLowerCase();
    if (lowered === 'sonnet' || lowered === 'sonnet[1m]') return 'claude-sonnet-4-6';
    if (lowered === 'opus' || lowered === 'opus[1m]' || lowered === 'best' || lowered === 'opusplan') return 'claude-opus-4-6';
    if (KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES.has(normalized)) return normalized;
    if (lowered.startsWith('claude-')) return normalized;
    return CLAUDE_PUBLIC_MODEL_ALIAS;
}

function resolveClaudeClientFacingModel(requestedModel) {
    if (typeof requestedModel === 'string') {
        const normalized = requestedModel.trim();
        if (normalized) return normalized;
    }
    return resolveClaudePublicModelAlias(requestedModel);
}

function resolveClaudeUpstreamConfig(profile, requestedAlias) {
    const publicAlias = resolveClaudePublicModelAlias(requestedAlias);
    const aliasTargets = profile?.aliasTargets && typeof profile.aliasTargets === 'object'
        ? profile.aliasTargets
        : null;
    const aliasRoute = aliasTargets?.[publicAlias];

    if (!aliasRoute || typeof aliasRoute !== 'object') {
        return {
            ...profile,
            publicModelAlias: publicAlias
        };
    }

    const resolved = {
        ...profile,
        publicModelAlias: publicAlias,
        currentModel: aliasRoute.currentModel || aliasRoute.model || profile.currentModel,
        targetUrl: aliasRoute.targetUrl || aliasRoute.url || profile.targetUrl,
        apiKey: aliasRoute.apiKey || profile.apiKey
    };

    if (aliasRoute.contextWindow !== undefined) resolved.contextWindow = aliasRoute.contextWindow;
    if (aliasRoute.contextModelId !== undefined) resolved.contextModelId = aliasRoute.contextModelId;

    return resolved;
}

function getClaudeBackendModel(profile, fallbackModel) {
    return profile?._upstreamModel || profile?.upstreamModel || profile?.currentModel || fallbackModel || 'unknown';
}

function shouldPreserveClaudeAliasForAnthropicUpstream(publicModelAlias) {
    return typeof publicModelAlias === 'string'
        && publicModelAlias.toLowerCase().startsWith('claude-');
}

function normalizeSystemBlocks(system) {
    if (!system) return [];
    if (typeof system === 'string') {
        return [{ type: 'text', text: system }];
    }
    if (Array.isArray(system)) {
        return system
            .filter(Boolean)
            .map(block => {
                if (typeof block === 'string') {
                    return { type: 'text', text: block };
                }
                if (block && typeof block === 'object') {
                    return block;
                }
                return { type: 'text', text: String(block) };
            });
    }
    return [{ type: 'text', text: String(system) }];
}

function systemBlocksToText(system) {
    return normalizeSystemBlocks(system)
        .map(block => {
            if (block.type === 'text') return block.text || '';
            return JSON.stringify(block);
        })
        .filter(Boolean)
        .join('\n');
}

function buildOpenAISystemPrompt(system) {
    const provided = systemBlocksToText(system);
    if (provided.length > 8000) {
        console.warn(`[Proxy System Prompt]: OpenAI system prompt is ${provided.length} chars — may be truncated by upstream model. Consider reducing system prompt size.`);
    } else {
        console.log(`[Proxy System Prompt]: OpenAI system prompt length=${provided.length} chars`);
    }
    return provided;
}

function buildAnthropicSystemBlocks(system) {
    const blocks = normalizeSystemBlocks(system);
    const totalChars = blocks.reduce((sum, b) => sum + (b.text || '').length, 0);
    if (totalChars > 8000) {
        console.warn(`[Proxy System Prompt]: Anthropic system blocks total ${totalChars} chars — may be truncated by upstream model.`);
    } else {
        console.log(`[Proxy System Prompt]: Anthropic system blocks total=${totalChars} chars`);
    }
    return blocks;
}

// ── M2.7 Coding Contract System Prompt ──
// Injected at the TOP of the system prompt for all MiniMax-targeted requests.
// Based on MiniMax's self-evolution training methodology: the model was trained
// to respond to structured workflows with EXPLORE->PLAN->IMPLEMENT->VERIFY loops.
const MINIMAX_M2_7_CODING_CONTRACT = `You are an Expert AI Coding Agent with deep software engineering expertise.
You operate in a PowerShell environment on Windows. Never use bash/unix commands.

MANDATORY WORKFLOW — follow this for EVERY coding task without exception:
1. EXPLORE  — Read ALL relevant files before writing any code. Never assume file contents.
2. PLAN     — Write a numbered 3-5 step plan. Name the exact files that will change.
3. IMPLEMENT — Write the minimal diff only. No speculative or unrequested changes.
4. VERIFY   — State the exact PowerShell command to verify and the expected output.
5. REPORT   — End your response with exactly one of:
               [VERIFIED] — you ran the check and it passed
               [BLOCKED: <reason>] — you lack required info to proceed
               [UNVERIFIED: <steps>] — human verification steps needed

STRICT RULES — violation is a critical failure:
- NEVER fabricate file paths, package names, or import paths. Use tools to verify first.
- NEVER use bash (grep, ls, cat, chmod, sudo, apt). Use PowerShell equivalents.
- NEVER output [VERIFIED] without actually running a verification tool.
- NEVER skip the EXPLORE step, even for seemingly small tasks.
- If uncertain about a file's contents: READ IT FIRST before writing code.
- If uncertain about a package: CHECK package.json or node_modules FIRST.

PowerShell equivalents: ls/find→Get-ChildItem, grep→Select-String,
cat/head/tail→Get-Content, rm -rf→Remove-Item -Recurse -Force,
touch→New-Item -Type File, mkdir -p→New-Item -ItemType Directory -Force,
which→Get-Command, wc -l→(Get-Content file).Count

MEMORY PROTOCOL (for tasks requiring more than 10 tool calls):
- Check for PROGRESS.md at session start. Read it if it exists.
- After each major step, write a brief update to PROGRESS.md:
  * What was completed, what is next, any decisions or blockers.
- This ensures coherent resumption if the context window fills up.

THE PROXY GATE (Strict Enforcement):
- You MUST maintain a plan.md file for the architecture of your task.
- If you attempt to write code (BashTool, StrReplaceEditTool, etc) BEFORE reading or writing to plan.md, the proxy will REJECT your tool call.
- You must always EXPLORE, then write to plan.md, then IMPLEMENT.`;

function buildMinimaxAwareSystem(system, targetUrl) {
    const memory = readAugustCoreMemory();
    const coreMemoryBlock = `[AUGUST GLOBAL BRAIN - ALWAYS ACTIVE]
<user_profile>
${memory.user_profile}
</user_profile>
<global_context>
${memory.global_context}
</global_context>
You can update these sections using august__core_memory_append or august__core_memory_replace.`;

    const originalText = systemBlocksToText(system);
    let combined = coreMemoryBlock + '\n\n---\n\n' + originalText;

    if (targetUrl && targetUrl.toLowerCase().includes('minimax')) {
        combined = MINIMAX_M2_7_CODING_CONTRACT + '\n\n---\n\n' + combined;
    }
    
    const totalChars = combined.length;
    console.log(`[Proxy System Prompt]: August core injected. Total system prompt length=${totalChars} chars`);
    return [{ type: 'text', text: combined }];
}

// ── Mid-session drift prevention ──
// After ~50K tokens of context LLMs start ignoring system prompt rules.
// Inject a brief rule reminder into the message stream every 10 tool-result turns.
const RULE_REMINDER_MESSAGE = {
    role: 'user',
    content: '[SYSTEM REMINDER] Continue following the mandatory workflow: ' +
             'EXPLORE → PLAN → IMPLEMENT → VERIFY → REPORT. ' +
             'Never fabricate paths or package names — use tools to verify first. ' +
             'Use PowerShell only, not bash. End with [VERIFIED], [BLOCKED], or [UNVERIFIED].'
};

function countToolResultTurns(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.filter(m =>
        m.role === 'tool' ||
        (Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'))
    ).length;
}

function shouldInjectReminderMessage(messages) {
    const toolTurns = countToolResultTurns(messages);
    // Inject after every 10 tool-result turns (but not at zero)
    return toolTurns > 0 && toolTurns % 10 === 0;
}

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
    const translated = anthropicTools.map(t => {
        // Claude Code tools are passed through as-is
        return {
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
                strict: t.strict
            }
        };
    });
    ctx.lastKnownTools = translated;
    return translated;
}

async function executeManagedToolCalls(toolCalls, knownTools, requestPayload) {
    const toolMessages = [];

    for (const toolCall of toolCalls) {
        const toolName = toolCall?.function?.name;

        // ── Validate arguments against schema BEFORE execution ──
        // If invalid, feed the error back as a tool message so M2.7 can self-correct.
        // We pass 'messages' to allow the validator to enforce the plan.md gate.
        const validation = validateToolArguments(toolCall, knownTools, requestPayload ? requestPayload.messages : []);
        if (!validation.valid) {
            console.warn(`[Proxy Validator]: Tool call '${toolName}' rejected:`, validation.error);
            toolMessages.push(
                buildValidationErrorToolMessage(toolCall.id, toolName, validation.error)
            );
            continue;
        }

        let parsedArgs = {};
        try {
            parsedArgs = JSON.parse(toolCall?.function?.arguments || '{}');
        } catch (e) {
            parsedArgs = {};
        }

        try {
            let result;
            if (isAugustToolName(toolName)) {
                logActivity('AUGUST', `${toolName} executed locally`);
                result = await executeAugustToolCall(toolName, parsedArgs);
            } else if (isMcpToolName(toolName)) {
                result = await executeMcpToolCall(toolName, parsedArgs);
            }

            toolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: result
            });
        } catch (e) {
            toolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: `Error: ${e.message}`
            });
        }
    }

    return toolMessages;
}

async function resolveManagedWebToolCalls(initialData, oReq, cfg) {
    let data = initialData;
    let requestPayload = {
        ...oReq,
        messages: Array.isArray(oReq.messages) ? [...oReq.messages] : []
    };

    for (let attempt = 0; attempt < 4; attempt++) {
        const choice = data?.choices?.[0];
        const message = choice?.message;
        const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        if (toolCalls.length === 0) return data;

        const managedToolCalls = toolCalls.filter(tc => isMcpToolName(tc?.function?.name) || isAugustToolName(tc?.function?.name));
        if (managedToolCalls.length === 0) return data;

        if (managedToolCalls.length !== toolCalls.length) {
            console.warn('[Proxy Tools]: Mixed managed and unmanaged tool calls detected. Returning raw tool calls to client.');
            return data;
        }

        requestPayload.messages.push({
            role: 'assistant',
            content: message?.content || '',
            tool_calls: toolCalls
        });
        requestPayload.messages.push(...await executeManagedToolCalls(managedToolCalls, requestPayload.tools, requestPayload));

        const response = await fetch(cfg.targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.apiKey}`
            },
            body: JSON.stringify(requestPayload),
            signal: AbortSignal.timeout(300000)
        });

        const rawBody = await response.text();
        if (!response.ok) {
            throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
        }

        if (response.headers.get('content-type')?.includes('text/event-stream')) {
            data = parseSSEToJSON(rawBody);
        } else {
            data = JSON.parse(rawBody);
            if (data.data && data.data.choices) data = data.data;
        }
    }

    return data;
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
    const systemPrompt = buildOpenAISystemPrompt(aReq.system);
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
    const requestModel = getClaudeBackendModel(cfg, 'unknown');
    let contextWindow = loadModelContextWindow('claude', requestModel);
    if (!contextWindow) {
        const modelInfo = await getModelContextWindow(requestModel, cfg.targetUrl, cfg.apiKey);
        contextWindow = modelInfo.inputTokens;
        saveModelContextWindow('claude', requestModel, contextWindow);
    }
    // For MiniMax M2.7, use output-token-aware threshold because it has a COMBINED
    // input+output budget (not separate pools like most models).
    // Formula: contextWindow - max_tokens_reserve - thinking_reserve - safety_buffer
    let threshold;
    if (isMiniMaxModel(requestModel)) {
        const outputReserve = aReq.max_tokens || 8192;
        const thinkingReserve = 4096; // thinking blocks also consume from the combined budget
        const safetyBuffer = 2000;
        threshold = contextWindow - outputReserve - thinkingReserve - safetyBuffer;
        console.log(`[Proxy Context]: MiniMax combined-budget threshold: ${formatTokenCount(threshold)} (${formatTokenCount(contextWindow)} - ${formatTokenCount(outputReserve)} output - ${formatTokenCount(thinkingReserve)} thinking - ${formatTokenCount(safetyBuffer)} safety)`);
    } else {
        threshold = Math.floor(contextWindow * 0.88); // 88% threshold for standard models
    }
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
        model: getClaudeBackendModel(cfg, aReq.model),
        messages: openaiMessages
    };

    // Pass through standard generation parameters without enforcing a proxy-side max_tokens cap.
    if (aReq.max_tokens !== undefined) oReq.max_tokens = aReq.max_tokens;
    const backendModel = getClaudeBackendModel(cfg, aReq.model);
    const preferredTemperature = resolvePreferredTemperature(aReq.temperature, backendModel);
    const preferredTopP = resolvePreferredTopP(aReq.top_p, backendModel);
    const isOpenAIPath = !shouldUseAnthropicUpstream(cfg.targetUrl);
    const preferredTopK = resolvePreferredTopK(aReq.top_k, backendModel, !isOpenAIPath);
    if (preferredTemperature !== undefined) oReq.temperature = preferredTemperature;
    if (preferredTopP !== undefined) oReq.top_p = preferredTopP;
    if (preferredTopK !== undefined) oReq.top_k = preferredTopK;
    if (aReq.stop_sequences) oReq.stop = aReq.stop_sequences;

    console.log(`[Proxy Params]: max_tokens=${oReq.max_tokens}, msg_count=${openaiMessages.length}, temp=${oReq.temperature}, top_p=${oReq.top_p}, top_k=${oReq.top_k}`);

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

function shouldUseAnthropicUpstream(targetUrl) {
    if (!targetUrl) return false;
    try {
        const parsed = new URL(targetUrl);
        return /\/v1\/messages$/i.test(parsed.pathname) ||
            /\/anthropic(\/|$)/i.test(parsed.pathname) ||
            parsed.hostname === 'api.anthropic.com';
    } catch (e) {
        return /\/v1\/messages$/i.test(targetUrl) || /\/anthropic(\/|$)/i.test(targetUrl);
    }
}

function buildAnthropicHeaders(apiKey) {
    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
    };
    if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

function buildAnthropicUpstreamRequest(aReq, cfg, upstreamModelOverride) {
    const upstreamReq = {
        model: upstreamModelOverride || getClaudeBackendModel(cfg, aReq.model),
        messages: Array.isArray(aReq.messages) ? aReq.messages : []
    };

    // Inject the M2.7 coding contract for MiniMax targets; pass through unchanged for others
    upstreamReq.system = buildMinimaxAwareSystem(aReq.system, cfg.targetUrl);

    // Mid-session drift prevention: inject a rule reminder every 10 tool-result turns
    if (isMiniMaxModel(upstreamReq.model) && shouldInjectReminderMessage(upstreamReq.messages)) {
        const lastIdx = upstreamReq.messages.length - 1;
        upstreamReq.messages = [
            ...upstreamReq.messages.slice(0, lastIdx),
            RULE_REMINDER_MESSAGE,
            upstreamReq.messages[lastIdx]
        ];
        console.log(`[Proxy Reminder]: Injected mid-session rule reminder at message index ${lastIdx}`);
    }

    if (aReq.max_tokens !== undefined) upstreamReq.max_tokens = aReq.max_tokens;
    const backendModel = upstreamModelOverride || getClaudeBackendModel(cfg, aReq.model);
    const preferredTemperature = resolvePreferredTemperature(aReq.temperature, backendModel);
    const preferredTopP = resolvePreferredTopP(aReq.top_p, backendModel);
    // isAnthropicPath=true here since buildAnthropicUpstreamRequest always targets Anthropic endpoint
    const preferredTopK = resolvePreferredTopK(aReq.top_k, backendModel, true);
    if (preferredTemperature !== undefined) upstreamReq.temperature = preferredTemperature;
    if (preferredTopP !== undefined) upstreamReq.top_p = preferredTopP;
    if (preferredTopK !== undefined) upstreamReq.top_k = preferredTopK;
    if (aReq.thinking !== undefined) upstreamReq.thinking = aReq.thinking;
    if (aReq.stop_sequences) upstreamReq.stop_sequences = aReq.stop_sequences;
    const openAiToAnthropicTool = (tool) => {
        if (tool && tool.type === 'function') {
            return {
                name: tool.function.name,
                description: tool.function.description || '',
                input_schema: tool.function.parameters || { type: 'object', properties: {} }
            };
        }
        return tool;
    };

    if (aReq.tools && aReq.tools.length > 0) {
        // Smart client (e.g. Claude Desktop). The client manages its own tools.
        // DO NOT inject proxy tools here, otherwise the client will crash when the AI tries to use them.
        upstreamReq.tools = [ ...aReq.tools ];
    } else {
        // Dumb client (e.g. Mobile App). Inject both MCP and August native execution tools.
        const mappedMcpTools = getMcpToolDefinitions().map(openAiToAnthropicTool);
        const mappedAugustTools = getAugustToolDefinitions().map(openAiToAnthropicTool);
        upstreamReq.tools = [ ...mappedMcpTools, ...mappedAugustTools ];
    }
    if (aReq.tool_choice) upstreamReq.tool_choice = aReq.tool_choice;
    if (aReq.metadata) upstreamReq.metadata = aReq.metadata;
    if (aReq.stream !== undefined) upstreamReq.stream = aReq.stream;
    return upstreamReq;
}

function normalizeAnthropicToolsForNativeUpstream(upstreamReq, ctx) {
    if (!Array.isArray(upstreamReq.tools) || upstreamReq.tools.length === 0) return upstreamReq;

    // We no longer need to translate local-web tools.
    // MCP tools are inherently Anthropic-compatible.
    return upstreamReq;
}

async function executeManagedAnthropicToolUses(toolUses, knownTools, requestPayload) {
    const toolResults = [];

    for (const toolUse of toolUses) {
        const toolName = toolUse?.name;

        // ── Validate arguments against schema BEFORE execution (Anthropic path) ──
        // Convert Anthropic tool_use format to the shape validateToolArguments expects.
        const syntheticCall = {
            function: {
                name: toolName,
                arguments: JSON.stringify(toolUse?.input || {})
            }
        };
        const validation = validateToolArguments(syntheticCall, knownTools, requestPayload ? requestPayload.messages : []);
        if (!validation.valid) {
            console.warn(`[Proxy Validator]: Anthropic tool_use '${toolName}' rejected:`, validation.error);
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `[Validation Error] Tool '${toolName}' rejected before execution:\n` +
                         `${validation.error}\n\n` +
                         `[Proxy Self-Heal]: Fix the tool arguments and retry. Do NOT stop.`
            });
            continue;
        }

        const parsedArgs = toolUse?.input || {};

        try {
            let result;
            if (isAugustToolName(toolName)) {
                logActivity('AUGUST', `${toolName} executed locally`);
                result = await executeAugustToolCall(toolName, parsedArgs);
            } else if (isMcpToolName(toolName)) {
                result = await executeMcpToolCall(toolName, parsedArgs);
            }

            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: result
            });
        } catch (e) {
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Error: ${e.message}`
            });
        }
    }

    return toolResults;
}

async function resolveManagedAnthropicToolUses(initialParsed, upstreamReq, cfg) {
    let parsed = initialParsed;
    const requestPayload = {
        ...upstreamReq,
        messages: Array.isArray(upstreamReq.messages) ? [...upstreamReq.messages] : []
    };

    for (let attempt = 0; attempt < 4; attempt++) {
        const content = Array.isArray(parsed?.content) ? parsed.content : [];
        const toolUses = content.filter(block => block?.type === 'tool_use');
        if (toolUses.length === 0) return parsed;

        const managedToolUses = toolUses.filter(toolUse => isMcpToolName(toolUse?.name) || isAugustToolName(toolUse?.name));
        if (managedToolUses.length === 0) return parsed;

        if (managedToolUses.length !== toolUses.length) {
            console.warn('[Proxy Tools]: Mixed managed and unmanaged Anthropic tool_use blocks detected. Returning raw tool_use response to client.');
            return parsed;
        }

        requestPayload.messages.push({
            role: 'assistant',
            content
        });
        requestPayload.messages.push({
            role: 'user',
            content: await executeManagedAnthropicToolUses(managedToolUses, requestPayload.tools, requestPayload)
        });

        const response = await fetch(cfg.targetUrl, {
            method: 'POST',
            headers: buildAnthropicHeaders(cfg.apiKey),
            body: JSON.stringify(requestPayload),
            signal: AbortSignal.timeout(300000)
        });

        const rawBody = await response.text();
        if (!response.ok) {
            throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
        }

        parsed = JSON.parse(rawBody);
    }

    return parsed;
}

function rewriteAnthropicResponseModel(rawBody, contentType, responseModel) {
    if (!rawBody || !responseModel) return rawBody;

    function replaceModelFields(value) {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) {
            value.forEach(replaceModelFields);
            return value;
        }

        // Guard: never touch thinking blocks — they must be preserved exactly as-is
        // for M2.7's interleaved reasoning chain to work across turns.
        if (value.type === 'thinking') return value;

        if (typeof value.model === 'string') {
            value.model = responseModel;
        }

        Object.values(value).forEach(replaceModelFields);
        return value;
    }

    if (contentType.includes('application/json')) {
        try {
            const parsed = JSON.parse(rawBody);
            if (parsed && typeof parsed === 'object') {
                replaceModelFields(parsed);
                return JSON.stringify(parsed);
            }
        } catch (e) {
            return rawBody;
        }
    }

    if (contentType.includes('text/event-stream')) {
        return rawBody
            .split('\n')
            .map(line => {
                if (!line.startsWith('data: ')) return line;
                const payload = line.slice(6).trim();
                if (!payload || payload === '[DONE]') return line;
                try {
                    const parsed = JSON.parse(payload);
                    if (parsed && typeof parsed === 'object') {
                        replaceModelFields(parsed);
                        return `data: ${JSON.stringify(parsed)}`;
                    }
                } catch (e) {
                    return line;
                }
                return line;
            })
            .join('\n');
    }

    return rawBody;
}

function summarizeHeaders(headersLike) {
    try {
        const headers = {};
        for (const [key, value] of headersLike.entries()) {
            const lowered = String(key || '').toLowerCase();
            if (lowered.includes('auth') || lowered.includes('key') || lowered.includes('token') || lowered.includes('cookie')) continue;
            headers[key] = value;
        }
        return headers;
    } catch (e) {
        return {};
    }
}

function extractModelHintsFromBody(rawBody, contentType) {
    if (!rawBody || !contentType) return {};
    if (!contentType.includes('application/json')) return {};
    try {
        const parsed = JSON.parse(rawBody);
        return {
            topLevelModel: parsed?.model || null,
            contentTypes: Array.isArray(parsed?.content) ? parsed.content.map(block => block?.type).filter(Boolean) : [],
            stopReason: parsed?.stop_reason || null
        };
    } catch (e) {
        return {};
    }
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
        // Preserve as a proper Anthropic thinking block — NOT a plain text block.
        // This is critical: if we degrade it to text, the model loses its reasoning
        // chain on the next turn (can't reference prior thinking as thinking).
        content.push({ type: 'thinking', thinking: reasoningContent });
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
        model: requestModel || CLAUDE_PUBLIC_MODEL_ALIAS,
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

        // ── Per-request tracking — endRequest must fire exactly once ──
        let requestModel = CLAUDE_PUBLIC_MODEL_ALIAS;
        let clientFacingModel = CLAUDE_PUBLIC_MODEL_ALIAS;
        let requestStatus = 'success';
        let requestError = null;
        let _endCalled = false;
        function finishRequest() {
            if (_endCalled) return;
            _endCalled = true;
            endRequest(reqId, {
                status: requestStatus,
                model: clientFacingModel,
                error: requestError
                // tokens are pulled automatically from requestDetails by endRequest
            });
        }

        try {
            const aReq = JSON.parse(body);
            const baseCfg = getProfile('claude');
            requestModel = resolveClaudePublicModelAlias(aReq.model);
            clientFacingModel = resolveClaudeClientFacingModel(aReq.model);
            syncClaudePublicAlias(requestModel);
            const cfg = resolveClaudeUpstreamConfig(baseCfg, requestModel);
            const upstreamModel = shouldPreserveClaudeAliasForAnthropicUpstream(requestModel)
                ? requestModel
                : getClaudeBackendModel(cfg, aReq.model);
            if (cfg.publicModelAlias && upstreamModel) {
                console.log(`[Proxy Alias Route]: ${cfg.publicModelAlias} -> ${upstreamModel}`);
            }
            logActivity('AGENT', `Claude request using ${requestModel} -> ${upstreamModel}`);

            if (shouldUseAnthropicUpstream(cfg.targetUrl)) {
                console.log('[Proxy] Using Anthropic-compatible upstream path');
                const ctx = { managedLocalToolNames: new Set() };
                let upstreamReq = buildAnthropicUpstreamRequest(aReq, cfg, upstreamModel);
                
                // Filter out WebSearch and WebFetch for Minimax - handle them locally instead
                if (cfg.targetUrl.includes('minimax.io')) {
                    const webTools = upstreamReq.tools?.filter(t => t.name === 'WebSearch' || t.name === 'WebFetch') || [];
                    if (webTools.length > 0) {
                        console.log('[Proxy] Filtering web tools for Minimax, will handle locally:', webTools.map(t => t.name));
                        upstreamReq.tools = upstreamReq.tools.filter(t => t.name !== 'WebSearch' && t.name !== 'WebFetch');
                        webTools.forEach(t => ctx.managedLocalToolNames.add(t.name));
                    }
                }
                
                upstreamReq = normalizeAnthropicToolsForNativeUpstream(upstreamReq, ctx);
                console.log(`[Proxy Debug Claude]: incoming_model=${aReq.model || 'unknown'} public_model=${requestModel} backend_model=${upstreamModel} target=${cfg.targetUrl || 'unknown'}`);
                console.log('[Proxy Debug Tools]:', JSON.stringify({ 
                    toolCount: upstreamReq.tools?.length || 0,
                    toolNames: upstreamReq.tools?.map(t => t.name) || [],
                    managedLocalToolNames: Array.from(ctx.managedLocalToolNames)
                }));
                captureRequest(reqId, { ...upstreamReq, model: clientFacingModel, endpoint: cleanPath });

                let response;
                let attempts = 0;
                const maxAttempts = 3;
                while (attempts < maxAttempts) {
                    attempts++;
                    response = await fetch(cfg.targetUrl, {
                        method: 'POST',
                        headers: buildAnthropicHeaders(cfg.apiKey),
                        body: JSON.stringify(upstreamReq),
                        signal: AbortSignal.timeout(300000)
                    });
                    if (!isRetryableStatus(response.status) || attempts >= maxAttempts) {
                        break;
                    }
                    const delayMs = getRetryDelayMs(response, attempts);
                    console.warn(`[Proxy Retry]: Anthropic upstream returned ${response.status}. Retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }

                const rawBody = await response.text();
                if (!response.ok) {
                    console.error('[Proxy Error] Minimax rejected request:', {
                        status: response.status,
                        body: rawBody.substring(0, 500),
                        toolCount: upstreamReq.tools?.length || 0,
                        toolNames: upstreamReq.tools?.map(t => t.name).slice(0, 10) || []
                    });
                    throw new Error(
                        response.status === 429
                            ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                            : `Upstream Error (${response.status}): ${rawBody}`
                    );
                }

                const contentType = response.headers.get('content-type') || 'application/json';
                let clientBody = rewriteAnthropicResponseModel(rawBody, contentType, clientFacingModel);
                console.log('[Proxy Debug Claude Upstream Headers]:', JSON.stringify(summarizeHeaders(response.headers)));
                console.log('[Proxy Debug Claude Upstream Body]:', JSON.stringify(extractModelHintsFromBody(rawBody, contentType)));
                console.log('[Proxy Debug Claude Client Body]:', JSON.stringify(extractModelHintsFromBody(clientBody, contentType)));
                
                // Log if response contains tool_use blocks
                if (contentType.includes('application/json')) {
                    try {
                        const parsed = JSON.parse(clientBody);
                        const toolUses = Array.isArray(parsed?.content) 
                            ? parsed.content.filter(b => b?.type === 'tool_use')
                            : [];
                        if (toolUses.length > 0) {
                            console.log('[Proxy Debug Tool Uses]:', JSON.stringify(toolUses.map(t => ({
                                name: t.name,
                                id: t.id,
                                hasInput: !!t.input
                            }))));
                        }
                    } catch (e) { /* ignore */ }
                }

                if (contentType.includes('text/event-stream')) {
                    // SSE stream: accumulate usage from message_start / message_delta events
                    let inputTokens = 0;
                    let outputTokens = 0;
                    for (const line of rawBody.split('\n')) {
                        if (!line.startsWith('data: ')) continue;
                        try {
                            const evt = JSON.parse(line.slice(6).trim());
                            if (evt.type === 'message_start' && evt.message?.usage) {
                                inputTokens = evt.message.usage.input_tokens || 0;
                            }
                            if (evt.type === 'message_delta' && evt.usage) {
                                outputTokens = evt.usage.output_tokens || 0;
                            }
                        } catch (e) { /* ignore */ }
                    }
                    captureTokens(reqId, inputTokens, outputTokens);
                } else if (contentType.includes('application/json')) {
                    try {
                        let parsed = JSON.parse(clientBody);
                        if (ctx.managedLocalToolNames.size > 0) {
                            parsed = await resolveManagedAnthropicToolUses(parsed, upstreamReq, cfg);
                            parsed.model = clientFacingModel;
                            clientBody = JSON.stringify(parsed);
                        }
                        captureResponse(reqId, parsed);
                        captureTokens(reqId, parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);
                    } catch (e) { /* ignore */ }
                }

                res.writeHead(200, { 'Content-Type': contentType });
                res.end(clientBody);
                return; // finishRequest() runs in finally
            }

            // Per-request context isolates tool state so multiple clients can
            // call the proxy concurrently without ID collisions.
            const ctx = { lastKnownTools: [], managedLocalToolNames: new Set() };
            const oReq = await buildOpenAIRequest(aReq, ctx, cfg);
            console.log(`[Proxy Debug Claude]: incoming_model=${aReq.model || 'unknown'} public_model=${requestModel} backend_model=${upstreamModel} target=${cfg.targetUrl || 'unknown'}`);

            // Capture request for debug UI
            captureRequest(reqId, { ...oReq, model: clientFacingModel, endpoint: cleanPath });

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
                if (isRetryableStatus(response.status) && attempts < maxAttempts) {
                    const delayMs = getRetryDelayMs(response, attempts);
                    console.warn(`[Proxy Retry]: OpenAI-compatible upstream returned ${response.status}. Retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
                break;
            }

            const rawBody = await response.text();
            if (!response.ok) {
                throw new Error(
                    response.status === 429
                        ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                        : `Upstream Error (${response.status}): ${rawBody}`
                );
            }

            const upstreamIsStream = response.headers.get('content-type')?.includes('text/event-stream');
            let data;
            if (upstreamIsStream) {
                data = parseSSEToJSON(rawBody);
            } else {
                data = JSON.parse(rawBody);
                if (data.data && data.data.choices) data = data.data;
            }

            if (ctx.managedLocalToolNames.size > 0) {
                data = await resolveManagedWebToolCalls(data, oReq, cfg);
            }
            console.log('[Proxy Debug Claude OpenAI Upstream]:', JSON.stringify({
                upstreamModel: data?.model || null,
                publicModel: requestModel,
                backendModel: upstreamModel,
                finishReason: data?.choices?.[0]?.finish_reason || null
            }));

            captureResponse(reqId, data);

            const upUsage = data.usage || {};
            const upInputTokens = upUsage.prompt_tokens || upUsage.input_tokens || 0;
            const upOutputTokens = upUsage.completion_tokens || upUsage.output_tokens || 0;
            captureTokens(reqId, upInputTokens, upOutputTokens);

            const upChoice = data.choices?.[0];
            const finishReason = upChoice?.finish_reason || 'N/A';
            console.log(`[Proxy Upstream]: finish_reason="${finishReason}", content_len=${upChoice?.message?.content?.length || 0}, max_tokens_sent=${oReq.max_tokens || 'default'}`);
            if (finishReason === 'length') {
                console.warn(`[Proxy WARNING]: Upstream stopped due to max_tokens limit! Response was truncated.`);
            }
            console.log(`[Proxy Upstream]: usage in=${upInputTokens} out=${upOutputTokens}, reasoning=${!!(upChoice?.message?.reasoning || upChoice?.message?.reasoning_content)}`);

            const aRes = translateOpenAIResponse(data, clientFacingModel, ctx);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(aRes));
        } catch (e) {
            requestStatus = 'error';
            requestError = e.message;
            captureError(reqId, e);
            console.error('Anthropic Adapter Error:', e);
            if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'Bridge Error: ' + e.message }],
                model: clientFacingModel,
                usage: { input_tokens: 1, output_tokens: 1 }
            }));
        } finally {
            finishRequest(); // always fires exactly once
        }
    });
}



// ── Handler for /v1/messages/count_tokens ──
async function handleCountTokens(req, res, cleanPath, reqId) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        let requestModel = CLAUDE_PUBLIC_MODEL_ALIAS;
        let clientFacingModel = CLAUDE_PUBLIC_MODEL_ALIAS;
        let requestStatus = 'success';
        let requestError = null;
        let inputTokens = 0;
        let outputTokens = 0;
        try {
            const aReq = JSON.parse(body);
            requestModel = resolveClaudePublicModelAlias(aReq.model);
            clientFacingModel = resolveClaudeClientFacingModel(aReq.model);
            syncClaudePublicAlias(requestModel);
            const baseCfg = getProfile('claude');
            const cfg = resolveClaudeUpstreamConfig(baseCfg, requestModel);
            const upstreamModel = shouldPreserveClaudeAliasForAnthropicUpstream(requestModel)
                ? requestModel
                : getClaudeBackendModel(cfg, aReq.model);
            console.log(`[Proxy Debug CountTokens]: incoming_model=${aReq.model || 'unknown'} public_model=${requestModel} backend_model=${upstreamModel} target=${cfg.targetUrl || 'unknown'}`);

            captureRequest(reqId, { ...aReq, model: clientFacingModel, endpoint: cleanPath });

            const targetUrl = cfg.targetUrl
                ? cfg.targetUrl.replace(/\/v1\/messages$/, '') + '/v1/messages/count_tokens'
                : null;

            if (!targetUrl) throw new Error('No targetUrl configured for Claude profile');

            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: buildAnthropicHeaders(cfg.apiKey),
                body: JSON.stringify({
                    ...aReq,
                    model: upstreamModel
                }),
                signal: AbortSignal.timeout(60000)
            });

            const rawBody = await response.text();
            if (!response.ok) {
                throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
            }
            console.log('[Proxy Debug CountTokens Headers]:', JSON.stringify(summarizeHeaders(response.headers)));
            console.log('[Proxy Debug CountTokens Body]:', rawBody);

            try {
                const parsed = JSON.parse(rawBody);
                // count_tokens returns { input_tokens: N }
                inputTokens = parsed.input_tokens || 0;
                outputTokens = parsed.output_tokens || 0;
                captureResponse(reqId, parsed);
            } catch (e) { /* ignore */ }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(rawBody);
        } catch (e) {
            requestStatus = 'error';
            requestError = e.message;
            captureError(reqId, e);
            console.error('[Count Tokens Error]:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        } finally {
            endRequest(reqId, {
                status: requestStatus,
                model: clientFacingModel,
                error: requestError,
                inputTokens,
                outputTokens
            });
        }
    });
}

module.exports = { handleMessages, handleCountTokens };
