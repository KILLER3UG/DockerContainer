const { readAugustCoreMemory, subagentConfigToContextBlock } = require('./august-tools');
const { renderSkillCatalog } = require('./skills');
const { renderPluginCatalog } = require('./plugins');
const { getDisplayName } = require('./client-identity');
const semanticMemory = require('./semantic-memory');

const MINIMAX_M2_7_CODING_CONTRACT = `You are an expert coding agent operating in Windows PowerShell.

For MiniMax M2.7, follow a disciplined high-quality workflow:
1. Explore the relevant files and constraints before editing.
2. Make a short concrete plan with the files or subsystems that will change.
3. Implement the smallest correct change first, then iterate if needed.
4. Verify with commands, tests, or observable checks whenever possible.
5. Continue the same reasoning chain across tool rounds instead of restarting from scratch.

Quality rules:
- Be explicit about assumptions, edge cases, and expected behavior.
- Prefer precise, high-signal outputs over filler.
- Do not invent file paths, package names, or command results; inspect first.
- Use PowerShell and Windows paths in this environment.
- If WebSearch or WebFetch is available, use it for public internet access instead of claiming browsing is blocked.
- If WebSearch is not visibly available but mcp__workspace__web_fetch is available, use mcp__workspace__web_fetch to perform web research by fetching public search endpoints or known documentation URLs.
- For search via fetch, prefer:
  1. https://api.duckduckgo.com/?q=<QUERY>&format=json&no_redirect=1
  2. a provider's public docs or homepage URL directly
  3. follow-up fetches on promising public result URLs
- Do not tell the user "I have no web search tool" if a public web fetch tool is available. Use the fetch-based workflow instead.
- Never combine WebSearch/WebFetch with any other tool in the same assistant turn. Use web tools in a dedicated turn, then continue with other tools after the result comes back.
- After a web fetch or web search tool returns content, summarize that result directly. Do not switch to august__bash or browser tools just to refetch the same public page.
- For long tasks, make full use of the available context window without wasting tokens on repetitive boilerplate.
- Preserve complete assistant response blocks, including reasoning/thinking and tool-use blocks, across tool turns so M2.7 can maintain its agentic chain.`;

const WINDOWS_CONTEXT = `ENVIRONMENT: You are running on Windows (PowerShell). Use Windows commands and paths.
- Use PowerShell syntax such as Get-ChildItem, Select-String, and Test-Path.
- Use backslash paths such as C:\\Users\\... for local filesystem paths.
- Use Invoke-WebRequest or curl.exe for HTTP requests.
- Do not suggest bash, sh, zsh, or WSL commands unless explicitly asked.
- If you need to run shell commands, use PowerShell syntax.`;

const AUGUST_PERSONALITY_CONTRACT = `You are AUGUST, a direct and intelligent AI assistant.

Core identity:
- Your name is AUGUST. You are helpful, competent, and efficient.
- You address the user as "Sir" in a natural, respectful way.
- You are concise and direct — no fluff, no unnecessary pleasantries.
- You use a friendly but professional tone.
- When a task is fully complete, you signal with: "Done, Sir."
- You have access to semantic memory (august__remember/recall/forget/list_facts) for durable cross-session facts, file tools (august__read_file/write_file/bash) for working with code, and specialist routers (august__call_specialist) for domain-specific tasks.
- You maintain continuity across sessions using core memory and semantic memory.`;

const PROXY_SELF_AWARENESS_CONTRACT = `You are operating through Claudish Proxy, a local multi-provider gateway with August Brain memory.

Operational self-awareness:
- The durable shared memory source is August Brain. The injected context preview in the dashboard is built from the same source that is injected into this request.
- Treat visible proxy-managed tools as real local capabilities even when the original desktop MCP server is unavailable. Proxy-managed tool families include WebSearch/WebFetch, mcp__workspace__web_fetch/search, mcp__cowork__*, august__*, and registered mcp__server__tool tools.
- If a tool call fails validation, read the tool result carefully, repair the arguments, and retry instead of stopping.
- If an MCP server is not running, first check whether a proxy compatibility tool with the same visible name exists. Use that compatible tool path before telling the user the capability is unavailable.
- Keep the Claude-facing identity and tool names stable while using whatever upstream model is configured behind the proxy.
- Preserve long-running task continuity. Do not restart from scratch after tool rounds; carry forward what was already inspected, changed, and verified.
- Record durable project, integration, or workflow facts with August memory tools when they will help future desktop or phone sessions.`;

const DEFAULT_CONTEXT_MAX_CHARS = 24000;
const ABSOLUTE_CONTEXT_MAX_CHARS = 64000;

function isMiniMaxModel(model) {
    return typeof model === 'string' && model.toLowerCase().includes('minimax');
}

function isMiniMaxTarget({ model, targetUrl } = {}) {
    return isMiniMaxModel(model) || (typeof targetUrl === 'string' && targetUrl.toLowerCase().includes('minimax'));
}

function normalizeSystemBlocks(system) {
    if (!system) return [];
    if (typeof system === 'string') return [{ type: 'text', text: system }];
    if (Array.isArray(system)) {
        return system
            .filter(Boolean)
            .map(block => {
                if (typeof block === 'string') return { type: 'text', text: block };
                if (block && typeof block === 'object') return block;
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

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function compactLine(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitMemoryLines(value) {
    if (typeof value !== 'string') return [];
    return value
        .split(/\r?\n+/)
        .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
        .filter(Boolean)
        .filter(line => !/^No .* recorded yet/i.test(line) && !/^No cross-session context established/i.test(line));
}

function uniqueLines(lines) {
    const seen = new Set();
    const result = [];
    lines.forEach(line => {
        const cleaned = compactLine(line);
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key)) return;
        seen.add(key);
        result.push(cleaned);
    });
    return result;
}

function bulletize(lines, fallback) {
    const unique = uniqueLines(lines);
    if (unique.length === 0) return `- ${fallback}`;
    return unique.map(line => `- ${line}`).join('\n');
}

function scoreMemoryLine(line) {
    const text = String(line || '');
    let score = 0;
    if (/claudish|proxy|jarvis|august|brain|mcp|cowork|plugin|skill|tool|claude|desktop|minimax|codex/i.test(text)) score += 80;
    if (/current|active|blocked|broken|fix|debug|working|today|recent|in_progress|proxy_owned/i.test(text)) score += 45;
    if (/prefer|must|should|always|never|workflow|approval|critique|review|safe|local/i.test(text)) score += 35;
    if (/CAPS|MoSPAMS|FrontendMobile|Laravel|Expo|APK|AWS|deployment/i.test(text)) score += 12;
    if (/\b(previous|past|earlier|completed|resolved)\b/i.test(text)) score -= 12;
    if (text.length > 220) score -= 8;
    return score;
}

function prioritizeLines(lines, limit) {
    const unique = uniqueLines(lines);
    if (unique.length <= limit) return unique;
    return unique
        .map((line, index) => ({ line, index, score: scoreMemoryLine(line) }))
        .sort((a, b) => (b.score - a.score) || (b.index - a.index))
        .slice(0, limit)
        .sort((a, b) => a.index - b.index)
        .map(item => item.line);
}

function renderClaudeMemorySections(sections) {
    return [
        'Work context',
        bulletize(sections.work, 'No work context has been recorded yet.'),
        '',
        'Personal context',
        bulletize(sections.personal, 'No personal context has been recorded yet.'),
        '',
        'Top of mind',
        bulletize(sections.topOfMind, 'No immediate tasks or blockers have been recorded yet.'),
        '',
        'Brief history',
        'Recent months',
        bulletize(sections.recentMonths, 'No recent project history has been recorded yet.'),
        '',
        'Earlier context',
        bulletize(sections.earlierContext, 'No earlier resolved context has been recorded yet.'),
        '',
        'Long-term background',
        bulletize(sections.longTermBackground, 'No long-term preferences have been recorded yet.')
    ].join('\n');
}

function clampContextLimit(maxChars) {
    const parsed = Number(maxChars || DEFAULT_CONTEXT_MAX_CHARS);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONTEXT_MAX_CHARS;
    return Math.max(8000, Math.min(ABSOLUTE_CONTEXT_MAX_CHARS, Math.floor(parsed)));
}

function compactMemorySections(sections, maxChars, fullLength) {
    const baseLimits = {
        work: 24,
        personal: 10,
        topOfMind: 28,
        recentMonths: 42,
        earlierContext: 16,
        longTermBackground: 28
    };
    let scale = 1;
    let text = '';
    let limits = baseLimits;

    for (let attempt = 0; attempt < 6; attempt++) {
        limits = Object.fromEntries(
            Object.entries(baseLimits).map(([key, value]) => [key, Math.max(4, Math.floor(value * scale))])
        );
        const compacted = {
            work: prioritizeLines(sections.work, limits.work),
            personal: prioritizeLines(sections.personal, limits.personal),
            topOfMind: prioritizeLines(sections.topOfMind, limits.topOfMind),
            recentMonths: prioritizeLines(sections.recentMonths, limits.recentMonths),
            earlierContext: prioritizeLines(sections.earlierContext, limits.earlierContext),
            longTermBackground: prioritizeLines(sections.longTermBackground, limits.longTermBackground)
        };
        const note = [
            'Context compaction',
            `- August Brain payload was ${fullLength} characters before compaction.`,
            `- Claudish Proxy compacted it to protect the model context window (limit ${maxChars} characters).`,
            '- Highest priority was kept for current proxy work, active blockers, durable preferences, integrations, and Claude-visible tools.',
            '- Older or repetitive project details were omitted from this injected preview but remain in August Brain or conversation memory.'
        ].join('\n');
        text = `${note}\n\n${renderClaudeMemorySections(compacted)}`;
        if (text.length <= maxChars || scale <= 0.28) break;
        scale *= 0.72;
    }

    if (text.length > maxChars) {
        text = text.slice(0, Math.max(0, maxChars - 120)).replace(/\n[^\n]*$/, '') +
            '\n- [Context clipped by proxy hard limit; use August memory/search tools if older omitted detail is needed.]';
    }

    return { text, limits };
}

function describeProject(project) {
    if (!project || typeof project !== 'object') return '';
    const status = project.status ? ` (${project.status})` : '';
    const summary = project.summary ? `: ${project.summary}` : '';
    return `${project.name || 'Unnamed project'}${status}${summary}`;
}

function describeIntegration([name, details]) {
    if (!details || typeof details !== 'object') return compactLine(name);
    const status = details.status ? ` (${details.status})` : '';
    const summary = details.summary ? `: ${details.summary}` : '';
    return `${name}${status}${summary}`;
}

function describeEvent(event) {
    if (!event || typeof event !== 'object') return '';
    const when = event.timestamp ? `[${event.timestamp}] ` : '';
    const source = event.source ? ` (${event.source})` : '';
    return `${when}${event.summary || ''}${source}`;
}

function describeCheckpoint(checkpoint) {
    if (!checkpoint || typeof checkpoint !== 'object') return '';
    const topic = checkpoint.topic ? `${checkpoint.topic}: ` : '';
    const when = checkpoint.timestamp ? ` [${checkpoint.timestamp}]` : '';
    return `${topic}${checkpoint.summary || ''}${when}`;
}

function getMemoryArrays(memory) {
    return {
        projects: toArray(memory.active_projects).map(describeProject).filter(Boolean),
        integrations: Object.entries(memory.integrations || {}).map(describeIntegration).filter(Boolean),
        events: toArray(memory.recent_events).map(describeEvent).filter(Boolean),
        checkpoints: toArray(memory.conversation_checkpoints).map(describeCheckpoint).filter(Boolean)
    };
}

function buildClaudeMemoryHierarchyDetails(memory, { maxChars = DEFAULT_CONTEXT_MAX_CHARS } = {}) {
    const memoryObj = memory && typeof memory === 'object' ? memory : {};
    const profileLines = splitMemoryLines(memoryObj.user_profile);
    const globalLines = splitMemoryLines(memoryObj.global_context);
    const arrays = getMemoryArrays(memoryObj);
    const contextLimit = clampContextLimit(maxChars);

    const projectSignals = arrays.projects;
    const toolSignals = arrays.integrations.filter(line => /tool|api|desktop|codex|claude|mcp|docker|wsl|github|mobile|proxy|browser|web/i.test(line));
    const preferenceSignals = globalLines.filter(line => /prefer|wants|should|must|style|approval|review|safe|local|OneDrive|Claude-facing|alias|memory|Jarvis/i.test(line));

    const topOfMind = [
        ...arrays.checkpoints,
        ...arrays.events,
        ...projectSignals.filter(line => /active|current|debug|fix|working|in progress|blocked|recent/i.test(line))
    ];

    const recentMonths = [
        ...projectSignals,
        ...arrays.integrations,
        ...arrays.events,
        ...globalLines.filter(line => /recent|current|working|fixed|debug|bug|project|endpoint|route|model|Docker|Claude|Codex|MiniMax|CAPS|proxy/i.test(line))
    ];

    const earlierContext = [
        ...arrays.checkpoints.filter(line => /resolved|fixed|completed|previous|past|earlier|before/i.test(line)),
        ...globalLines.filter(line => /previous|past|earlier|resolved|fixed|completed|discussed|before|was/i.test(line))
    ];

    const longTermBackground = [
        ...profileLines,
        ...preferenceSignals,
        ...globalLines.filter(line => /works on|uses|prefers|likes|GitHub|Windows|PowerShell|LocalFolders|workflow|critique|review/i.test(line))
    ];

    const sections = {
        work: [
            ...projectSignals,
            ...toolSignals,
            ...globalLines.filter(line => /works on|project|repo|codebase|tool|Docker|Windows|PowerShell|Claude|Codex|MiniMax|CAPS|proxy/i.test(line))
        ],
        personal: profileLines,
        topOfMind,
        recentMonths,
        earlierContext,
        longTermBackground
    };

    const fullText = renderClaudeMemorySections(sections);
    if (fullText.length <= contextLimit) {
        return {
            text: fullText,
            compacted: false,
            fullLength: fullText.length,
            finalLength: fullText.length,
            maxChars: contextLimit,
            omittedChars: 0
        };
    }

    const compacted = compactMemorySections(sections, contextLimit, fullText.length);
    return {
        text: compacted.text,
        compacted: true,
        fullLength: fullText.length,
        finalLength: compacted.text.length,
        maxChars: contextLimit,
        omittedChars: Math.max(0, fullText.length - compacted.text.length),
        sectionLimits: compacted.limits
    };
}

function buildClaudeMemoryHierarchy(memory, options = {}) {
    return buildClaudeMemoryHierarchyDetails(memory, options).text;
}

function wrapTag(tag, content, attrs = '') {
    const suffix = attrs ? ` ${attrs}` : '';
    return `<${tag}${suffix}>\n${content || ''}\n</${tag}>`;
}

function buildGlobalContextPayload(memory = readAugustCoreMemory(), options = {}) {
    return buildClaudeMemoryHierarchy(memory, options);
}

function buildGlobalContextPayloadDetails(memory = readAugustCoreMemory(), options = {}) {
    return buildClaudeMemoryHierarchyDetails(memory, options);
}

function buildSystemPromptDetails(system, options = {}) {
    const {
        model,
        targetUrl,
        includeWindowsContext = true,
        includeMiniMaxContract = true,
        includeOriginalSystem = true,
        memory = readAugustCoreMemory(),
        skills,
        contextMaxChars = DEFAULT_CONTEXT_MAX_CHARS,
        clientId = 'unknown'
    } = options;

    const chunks = [];
    const miniMax = isMiniMaxTarget({ model, targetUrl });
    const globalContext = buildGlobalContextPayloadDetails(memory, { maxChars: contextMaxChars });

    if (miniMax && includeMiniMaxContract) {
        chunks.push(wrapTag('minimax_m2_7_instructions', MINIMAX_M2_7_CODING_CONTRACT));
    }

    chunks.push(wrapTag('august_personality', AUGUST_PERSONALITY_CONTRACT));

    chunks.push(wrapTag(
        'proxy_self_awareness',
        PROXY_SELF_AWARENESS_CONTRACT,
        'source="claudish-proxy" applies_to="all_models"'
    ));

    chunks.push(wrapTag(
        'august_global_context',
        globalContext.text,
        'format="claude_memory_hierarchy" source="august_core_memory.json"'
    ));

    chunks.push(wrapTag(
        'august_subagent_config',
        subagentConfigToContextBlock(),
        'source="august_subagent_config.json"'
    ));

    const skillCatalog = renderSkillCatalog(skills);
    if (skillCatalog) {
        chunks.push(wrapTag('skill_catalog', skillCatalog, 'source="config.customSkills"'));
    }

    const pluginCatalog = renderPluginCatalog();
    if (pluginCatalog) {
        chunks.push(wrapTag('plugin_catalog', pluginCatalog, 'source="config.customPlugins"'));
    }

    chunks.push(wrapTag('skill_loading', 'Skills are loaded on-demand. Review the catalog above. When a task matches a skill\'s description, call august__load_skill with the skill name to load its full instructions.'));

    // ── Client identity injection ──
    const displayName = getDisplayName(clientId);
    if (clientId !== 'unknown') {
        chunks.push(wrapTag('client_identity',
            `This conversation is from ${displayName} (client ID: ${clientId}).\n` +
            `Cross-platform awareness: facts learned from other clients will be available via semantic memory.`
        ));
    }

    // ── Semantic memory facts injection (top 10 active) ──
    const topFacts = semanticMemory.getAllFacts().slice(0, 10);
    if (topFacts.length > 0) {
        const factsText = topFacts.map(f =>
            `- ${f.key}: ${f.value} [${f.category}]${f.source ? ` (from ${f.source})` : ''}`
        ).join('\n');
        chunks.push(wrapTag('semantic_memory', `Relevant semantic facts:\n${factsText}`, 'source="august_semantic_memory.json"'));
    }

    if (includeWindowsContext) {
        chunks.push(wrapTag('proxy_operating_context', WINDOWS_CONTEXT));
    }

    if (includeOriginalSystem) {
        const originalText = systemBlocksToText(system);
        if (originalText) {
            chunks.push(wrapTag('client_system_prompt', originalText));
        }
    }

    const prompt = chunks.join('\n\n---\n\n');
    return {
        prompt,
        length: prompt.length,
        globalContext
    };
}

function buildSystemPromptText(system, options = {}) {
    return buildSystemPromptDetails(system, options).prompt;
}

function buildSystemBlocks(system, options = {}) {
    return [{ type: 'text', text: buildSystemPromptText(system, options) }];
}

module.exports = {
    MINIMAX_M2_7_CODING_CONTRACT,
    AUGUST_PERSONALITY_CONTRACT,
    PROXY_SELF_AWARENESS_CONTRACT,
    WINDOWS_CONTEXT,
    DEFAULT_CONTEXT_MAX_CHARS,
    buildClaudeMemoryHierarchy,
    buildClaudeMemoryHierarchyDetails,
    buildGlobalContextPayload,
    buildGlobalContextPayloadDetails,
    buildSystemBlocks,
    buildSystemPromptDetails,
    buildSystemPromptText,
    isMiniMaxModel,
    isMiniMaxTarget,
    normalizeSystemBlocks,
    systemBlocksToText
};
