const { readAugustCoreMemory, writeAugustCoreMemory } = require('./august-tools');

/**
 * Extract plain text from a message content field.
 * Handles string content, Anthropic content arrays [{type:'text',text:'...'}],
 * and OpenAI content arrays [{type:'text',text:'...'}].
 * Strips images, tool_use, thinking blocks, etc.
 */
function extractTextFromContent(content) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
        .filter(b => b && (b.type === 'text' || b.type === 'output_text'))
        .map(b => b.text || '')
        .join('\n')
        .trim();
}

/**
 * Extract just the text from an assistant response object.
 * Handles both Anthropic format ({content:[...]}) and OpenAI format ({choices:[...]}).
 */
function extractAssistantText(assistantContent) {
    if (typeof assistantContent === 'string') return assistantContent.trim();
    if (!assistantContent || typeof assistantContent !== 'object') return '';

    // Anthropic format: { content: [{ type: 'text', text: '...' }, { type: 'thinking', ... }] }
    if (Array.isArray(assistantContent.content)) {
        return assistantContent.content
            .filter(b => b && b.type === 'text')
            .map(b => b.text || '')
            .join('\n')
            .trim();
    }

    // OpenAI format: { choices: [{ message: { content: '...' } }] }
    const choice = assistantContent.choices?.[0];
    if (choice?.message?.content) {
        return extractTextFromContent(choice.message.content);
    }

    return '';
}

const fs = require('fs');
const path = require('path');
const debugLogPath = path.join(__dirname, 'debug.txt');
const semanticMemory = require('./semantic-memory');
const _origLog = console.log;
const _origWarn = console.warn;

console.log = function(...args) {
    if (typeof args[0] === 'string' && args[0].includes('[Auto-Memory]')) {
        try { fs.appendFileSync(debugLogPath, new Date().toISOString() + ' LOG: ' + args.join(' ') + '\n'); } catch(e){}
    }
    _origLog.apply(console, args);
};

console.warn = function(...args) {
    if (typeof args[0] === 'string' && args[0].includes('[Auto-Memory]')) {
        try { fs.appendFileSync(debugLogPath, new Date().toISOString() + ' WARN: ' + args.join(' ') + '\n'); } catch(e){}
    }
    _origWarn.apply(console, args);
};

/**
 * Fires asynchronously at the end of a successful conversation turn.
 * Extracts persistent facts from the conversation and saves them to August Core Memory.
 */
async function extractAndSaveMemories(userMessages, assistantContent, cfg, upstreamModel, clientId) {
    try {
        const memory = readAugustCoreMemory();
        const currentContext = memory.global_context || "No cross-session context established.";
        
        // Grab the last 2 user messages, extract only text (strip images/files)
        const recentUserMsgs = (userMessages || []).filter(m => m.role === 'user').slice(-2);
        if (recentUserMsgs.length === 0) {
            console.log('[Auto-Memory] Skipped: no user messages found in conversation');
            return;
        }

        const textOnlyMessages = recentUserMsgs.map(m => {
            console.log(`[Auto-Memory] Raw user message content: ${JSON.stringify(m.content)}`);
            return {
                role: 'user',
                content: extractTextFromContent(m.content)
            };
        }).filter(m => m.content.length > 0);

        if (textOnlyMessages.length === 0) {
            console.log('[Auto-Memory] Skipped: user messages contained no text (images/files only)');
            return;
        }

        // Extract just the text from the assistant response (strip thinking, metadata)
        const assistantText = extractAssistantText(assistantContent);
        if (!assistantText || assistantText.length < 10) {
            console.log('[Auto-Memory] Skipped: assistant response too short or empty');
            return;
        }

        console.log(`[Auto-Memory] Starting extraction... (${textOnlyMessages.length} user msgs, ${assistantText.length} chars assistant text, model=${upstreamModel})`);

        const systemPrompt = `You are a background Memory Extractor for a personal AI assistant.
Your job is to read the latest user message and extract:
1. Long-term, persistent facts about the user, their projects, their tech stack, or their preferences. Ignore temporary chatter or coding bugs. Only extract things that will be true next week.
2. A very brief summary of what the user is currently working on or talking about in this conversation turn, to serve as a checkpoint so the AI remembers the ongoing topic.

CURRENT MEMORY:
${currentContext}

If the user says something that contradicts the current memory facts, you must delete the old fact and add the new one.
If no persistent facts are found, return empty arrays for add_facts and delete_facts.
For conversation_summary, always provide a 1-sentence summary of the current topic, unless it's just a greeting.

Respond ONLY with valid JSON in this exact format:
{
  "add_facts": ["The user prefers dark mode", "The user works on an app called ClaudishProxy"],
  "delete_facts": ["The user prefers light mode"],
  "conversation_summary": {
    "topic": "Claudish Proxy Bug Fix",
    "summary": "User is fixing background memory extraction logic in auto-memory.js."
  }
}`;

        // Determine the best endpoint to use from cfg
        let targetUrl = cfg.targetUrl;

        // Detect Anthropic-native endpoints that have no OpenAI-compatible alternative
        const isAnthropicNative = (
            targetUrl.includes('api.anthropic.com') ||
            (targetUrl.includes('/v1/messages') && !targetUrl.includes('/chat/completions') && !targetUrl.includes('minimax'))
        ) && !targetUrl.includes('/anthropic/v1/messages'); // Minimax wrapper handled below

        let response;
        if (isAnthropicNative) {
            console.log(`[Auto-Memory] Using Anthropic-native format -> ${targetUrl}`);
            const anthropicPayload = {
                model: upstreamModel || 'claude-sonnet-4-6',
                max_tokens: 300,
                temperature: 0.1,
                system: systemPrompt,
                messages: [
                    ...textOnlyMessages,
                    { role: 'assistant', content: assistantText },
                    { role: 'user', content: 'Extract memory now. Return ONLY raw JSON without markdown formatting.' }
                ]
            };
            const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
            if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

            response = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(anthropicPayload),
                signal: AbortSignal.timeout(30000)
            });
        } else {
            // Rewrite to OpenAI-compatible endpoint
            if (targetUrl.includes('/anthropic/v1/messages')) {
                targetUrl = targetUrl.replace('/anthropic/v1/messages', targetUrl.includes('minimax') ? '/v1/text/chatcompletion_v2' : '/v1/chat/completions');
            } else if (targetUrl.includes('/anthropic')) {
                targetUrl = targetUrl.replace('/anthropic', '/v1/text/chatcompletion_v2');
            }
            console.log(`[Auto-Memory] Using OpenAI-compatible format -> ${targetUrl}`);

            // Ensure we never send the fake Claude Desktop aliases (claude-opus-4-6, etc.) to OpenAI-compatible upstreams
            let memModel = upstreamModel;
            if (memModel && memModel.startsWith('claude-') && !isAnthropicNative) {
                memModel = cfg._upstreamModel || cfg.currentModel || "MiniMax-M2.7";
            }
            if (!memModel) memModel = "MiniMax-M2.7";
            
            const payload = {
                model: memModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...textOnlyMessages,
                    { role: "assistant", content: assistantText },
                    { role: "user", content: "Extract memory now. Return ONLY raw JSON without markdown formatting. You MUST start your response IMMEDIATELY with the '{' character. Do not output any thinking or analysis text before the JSON object." }
                ],
                max_tokens: 1500,
                temperature: 0.1
            };

            const headers = { 'Content-Type': 'application/json' };
            if (cfg.apiKey) {
                headers['Authorization'] = `Bearer ${cfg.apiKey}`;
                headers['x-api-key'] = cfg.apiKey;
            }

            response = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(30000)
            });
        }

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            console.warn(`[Auto-Memory] Extraction API returned HTTP ${response.status}: ${errBody.slice(0, 200)}`);
            return;
        }

        const data = await response.json();
        let jsonStr = '';
        if (data.choices && data.choices[0] && data.choices[0].message) {
            jsonStr = data.choices[0].message.content;
        } else if (data.content && data.content[0]) {
            jsonStr = data.content[0].text;
        }

        if (!jsonStr) {
            console.log('[Auto-Memory] Extraction model returned empty content');
            return;
        }

        console.log(`[Auto-Memory] Raw extraction response: ${jsonStr.slice(0, 200)}`);
        
        let cleanJsonStr = jsonStr.replace(/```json|```/gi, '').trim();
        // Strip out <think> blocks that reasoning models (like Minimax/DeepSeek) prepend
        cleanJsonStr = cleanJsonStr.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        
        // Find the first { and last } to ensure we only parse the JSON object
        const firstBrace = cleanJsonStr.indexOf('{');
        const lastBrace = cleanJsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            cleanJsonStr = cleanJsonStr.slice(firstBrace, lastBrace + 1);
        }

        const extracted = JSON.parse(cleanJsonStr);
        
        let updatedContext = currentContext;
        let modified = false;

        if (extracted.delete_facts && Array.isArray(extracted.delete_facts) && extracted.delete_facts.length > 0) {
            let lines = updatedContext.split('\n');
            lines = lines.filter(line => !extracted.delete_facts.some(d => line.toLowerCase().includes(d.toLowerCase())));
            updatedContext = lines.join('\n');
            modified = true;
        }

        if (extracted.add_facts && Array.isArray(extracted.add_facts) && extracted.add_facts.length > 0) {
            for (const fact of extracted.add_facts) {
                if (!updatedContext.includes(fact)) {
                    updatedContext += (updatedContext ? '\n' : '') + `- ${fact}`;
                    modified = true;
                }
            }
        }

        if (extracted.conversation_summary && extracted.conversation_summary.topic && extracted.conversation_summary.summary) {
            if (!memory.conversation_checkpoints) memory.conversation_checkpoints = [];
            memory.conversation_checkpoints.push({
                topic: extracted.conversation_summary.topic,
                summary: extracted.conversation_summary.summary,
                timestamp: new Date().toISOString()
            });
            // Keep only the last 15 checkpoints in the core memory
            if (memory.conversation_checkpoints.length > 15) {
                memory.conversation_checkpoints.shift();
            }

            // --- VECTOR DB INTEGRATION ---
            try {
                let embeddingsUrl = cfg.targetUrl;
                if (embeddingsUrl.includes('/anthropic')) {
                    embeddingsUrl = embeddingsUrl.replace('/anthropic/v1/messages', '/v1/embeddings').replace('/anthropic', '/v1/embeddings');
                } else if (embeddingsUrl.includes('/v1/')) {
                    embeddingsUrl = embeddingsUrl.substring(0, embeddingsUrl.indexOf('/v1/') + 4) + 'embeddings';
                } else {
                    embeddingsUrl = null;
                }

                if (embeddingsUrl) {
                    const textToEmbed = `Topic: ${extracted.conversation_summary.topic}\nSummary: ${extracted.conversation_summary.summary}`;
                    const embedHeaders = { 'Content-Type': 'application/json' };
                    if (cfg.apiKey) {
                        embedHeaders['Authorization'] = `Bearer ${cfg.apiKey}`;
                        embedHeaders['x-api-key'] = cfg.apiKey;
                    }
                    
                    const embedModel = cfg.embeddingModel || (embeddingsUrl.includes('minimax') ? 'embo-01' : 'text-embedding-3-small');

                    const embedResponse = await fetch(embeddingsUrl, {
                        method: 'POST',
                        headers: embedHeaders,
                        body: JSON.stringify({
                            model: embedModel,
                            input: textToEmbed
                        }),
                        signal: AbortSignal.timeout(10000)
                    });
                    
                    if (embedResponse.ok) {
                        const embedData = await embedResponse.json();
                        const vector = embedData.data?.[0]?.embedding;
                        if (vector && Array.isArray(vector)) {
                            const { saveCheckpointWithEmbedding } = require('./vector-db');
                            saveCheckpointWithEmbedding(
                                extracted.conversation_summary.topic,
                                extracted.conversation_summary.summary,
                                vector
                            );
                            console.log(`[Auto-Memory] ✓ Saved checkpoint to Infinite Vector Database.`);
                        }
                    } else {
                        const errText = await embedResponse.text().catch(() => '');
                        console.warn(`[Auto-Memory] Failed to get embedding for infinite memory: HTTP ${embedResponse.status} ${errText.slice(0, 100)}`);
                    }
                }
            } catch (err) {
                console.warn('[Auto-Memory] Vector DB integration error:', err.message);
            }

            modified = true;
        }

        if (modified) {
            memory.global_context = updatedContext.trim() || "No cross-session context established.";
            writeAugustCoreMemory(memory);
            console.log(`[Auto-Memory] ✓ Background extraction successful. Added ${extracted.add_facts?.length || 0} facts, deleted ${extracted.delete_facts?.length || 0} facts, added checkpoint: ${!!extracted.conversation_summary}.`);
        } else {
            console.log('[Auto-Memory] No new persistent facts found in this turn.');
        }

        // ── Semantic memory extraction pass ──
        try {
            const lastUserText = textOnlyMessages[textOnlyMessages.length - 1]?.content || '';
            const sourceId = clientId || 'unknown';
            const semanticPrompt = `Extract durable semantic facts from this user message. Return ONLY valid JSON array where each item has: {"key": "short_identifier", "value": "fact text", "category": "user_preference|user_detail|project_info|workflow_rule"}. If no facts, return []. Do not include markdown formatting.`;
            const semPayload = {
                model: upstreamModel || 'MiniMax-M2.7',
                messages: [
                    { role: 'system', content: semanticPrompt },
                    { role: 'user', content: lastUserText }
                ],
                max_tokens: 500,
                temperature: 0.1
            };

            let semTargetUrl = cfg.targetUrl;
            if (semTargetUrl.includes('/anthropic/v1/messages')) {
                semTargetUrl = semTargetUrl.replace('/anthropic/v1/messages', semTargetUrl.includes('minimax') ? '/v1/text/chatcompletion_v2' : '/v1/chat/completions');
            } else if (semTargetUrl.includes('/anthropic') && !semTargetUrl.includes('/chat/completions')) {
                semTargetUrl = semTargetUrl.replace('/v1/messages', '/v1/chat/completions');
            }

            const semHeaders = { 'Content-Type': 'application/json' };
            if (cfg.apiKey) semHeaders['Authorization'] = `Bearer ${cfg.apiKey}`;

            const semResponse = await fetch(semTargetUrl, {
                method: 'POST',
                headers: semHeaders,
                body: JSON.stringify(semPayload),
                signal: AbortSignal.timeout(15000)
            });

            if (semResponse.ok) {
                const semData = await semResponse.json();
                let semText = semData.choices?.[0]?.message?.content || '';
                semText = semText.replace(/```json|```/gi, '').trim();
                const firstB = semText.indexOf('[');
                const lastB = semText.lastIndexOf(']');
                if (firstB !== -1 && lastB !== -1) {
                    semText = semText.slice(firstB, lastB + 1);
                }
                const semFacts = JSON.parse(semText);
                if (Array.isArray(semFacts) && semFacts.length > 0) {
                    for (const fact of semFacts) {
                        if (fact.key && fact.value) {
                            semanticMemory.setFact(
                                fact.key,
                                fact.value,
                                fact.category || 'user_preference',
                                null,
                                sourceId
                            );
                        }
                    }
                    console.log(`[Auto-Memory] ✓ Extracted ${semFacts.length} semantic facts (source: ${sourceId})`);
                }
            }
        } catch (semErr) {
            console.log(`[Auto-Memory] Semantic extraction skipped: ${semErr.message}`);
        }

    } catch (e) {
        // Log with full details so the user can diagnose why extraction is failing
        console.warn('[Auto-Memory] Background extraction failed:', e.message);
        require('fs').appendFileSync(require('path').join(__dirname, 'debug.txt'), new Date().toISOString() + ' ERROR: ' + e.message + '\n' + e.stack + '\n');
    }
}

module.exports = { extractAndSaveMemories, extractTextFromContent, extractAssistantText };
