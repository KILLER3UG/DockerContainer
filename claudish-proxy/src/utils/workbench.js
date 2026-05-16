const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getProfile } = require('./config');
const { buildSystemPromptText } = require('./context-builder');
const semanticMemory = require('./semantic-memory');
const hostAgent = require('./host-agent');
const { getMcpToolDefinitions, executeMcpToolCall, isMcpToolName } = require('./mcp-client');
const { getAugustToolDefinitions, executeAugustToolCall, isAugustToolName } = require('./august-tools');
const { getCoworkToolDefinitions, executeCoworkToolCall, isCoworkToolName } = require('./cowork-tools');
const { executeManagedWebTool, isManagedWebToolName } = require('./local-web');

const sessions = new Map();
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = 'C:\\Users\\rober\\LocalFolders\\DockerContainer\\claudish-proxy';
const MAX_TOOL_LOOPS = 8;

function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createWorkbenchSession({ provider = 'claude' } = {}) {
    const session = {
        id: newId('wb'),
        provider: provider === 'codex' ? 'codex' : 'claude',
        messages: [],
        plan: null,
        approved: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    sessions.set(session.id, session);
    return summarizeSession(session);
}

function getWorkbenchSession(id) {
    if (id && sessions.has(id)) return sessions.get(id);
    return sessions.get(createWorkbenchSession().id);
}

function summarizeSession(session) {
    return {
        id: session.id,
        provider: session.provider,
        approved: session.approved,
        plan: session.plan,
        messageCount: session.messages.length,
        updatedAt: session.updatedAt
    };
}

function mapHostPath(inputPath) {
    const raw = String(inputPath || '').trim();
    if (!raw) return WORKSPACE_ROOT;
    const normalizedHost = HOST_ROOT.replace(/\\/g, '/').toLowerCase();
    const normalizedRaw = raw.replace(/\\/g, '/').toLowerCase();
    if (normalizedRaw === normalizedHost || normalizedRaw.startsWith(`${normalizedHost}/`)) {
        const suffix = raw.replace(/\\/g, '/').slice(HOST_ROOT.replace(/\\/g, '/').length).replace(/^\/+/, '');
        return path.join(WORKSPACE_ROOT, suffix);
    }
    return raw;
}

function resolveAnyPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return WORKSPACE_ROOT;
    const mapped = mapHostPath(inputPath);
    const resolved = path.resolve(mapped);
    return resolved;
}

function toDisplayPath(filePath) {
    return path.relative(WORKSPACE_ROOT, filePath).replace(/\\/g, '/') || '.';
}

const PROXY_ROOT = path.resolve(__dirname, '..');

function isProxyPath(filePath) {
    if (!filePath) return false;
    const resolved = path.resolve(String(filePath));
    const normalizedRoot = path.resolve(PROXY_ROOT).toLowerCase().replace(/\\/g, '/');
    const normalizedPath = resolved.toLowerCase().replace(/\\/g, '/');
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + '/');
}

function isProxyMutation(toolName, args) {
    const pathArgs = ['path', 'file_path', 'source', 'destination'];
    for (const arg of pathArgs) {
        if (args[arg] && isProxyPath(args[arg])) return true;
    }
    if (toolName === 'august__bash' || toolName === 'workbench_run_command') {
        const cmd = String(args.command || '').toLowerCase();
        const normalizedRoot = PROXY_ROOT.toLowerCase().replace(/\\/g, '/');
        if (cmd.includes(normalizedRoot)) return true;
    }
    if (toolName.startsWith('mcp__filesystem__')) {
        const mutOps = ['write_file', 'edit', 'create', 'move', 'delete', 'rename'];
        if (mutOps.some(op => toolName.includes(op))) {
            return isProxyPath(args.path) || isProxyPath(args.source) || isProxyPath(args.destination);
        }
    }
    return false;
}

function openAiToAnthropicTool(openAiTool) {
    return {
        name: openAiTool.function.name,
        description: openAiTool.function.description || '',
        input_schema: openAiTool.function.parameters || { type: 'object', properties: {} }
    };
}

function getAllTools() {
    const coreWorkbenchTools = [
        {
            name: 'workbench_list_directory',
            description: 'List files and folders anywhere on the filesystem.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Any file system path. Defaults to proxy root.' }
                }
            }
        },
        {
            name: 'workbench_read_file',
            description: 'Read any text file anywhere on the filesystem.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    max_chars: { type: 'number', description: 'Maximum characters to return. Defaults to 20000.' }
                },
                required: ['path']
            }
        },
        {
            name: 'workbench_search_files',
            description: 'Search text files for a query anywhere on the filesystem.',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    path: { type: 'string', description: 'Folder path to search. Defaults to proxy root.' },
                    limit: { type: 'number' }
                },
                required: ['query']
            }
        },
        {
            name: 'workbench_submit_plan',
            description: 'Submit an implementation plan for user review. Required BEFORE any mutation to proxy system files.',
            input_schema: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                    steps: { type: 'array', items: { type: 'string' } },
                    files: { type: 'array', items: { type: 'string' } },
                    risks: { type: 'array', items: { type: 'string' } },
                    verification: { type: 'array', items: { type: 'string' } }
                },
                required: ['summary', 'steps']
            }
        },
        {
            name: 'workbench_write_file',
            description: 'Write a complete file anywhere on the filesystem. If the path is inside the proxy system, an approved plan is required first.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' }
                },
                required: ['path', 'content']
            }
        },
        {
            name: 'workbench_replace_text',
            description: 'Replace exact text inside any file. If the path is inside the proxy system, an approved plan is required first.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    find: { type: 'string' },
                    replace: { type: 'string' }
                },
                required: ['path', 'find', 'replace']
            }
        },
        {
            name: 'workbench_run_command',
            description: 'Run a PowerShell command in the workspace root. If the command references proxy system files, an approved plan is required first.',
            input_schema: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    timeout_ms: { type: 'number' }
                },
                required: ['command']
            }
        },
        {
            name: 'workbench_spawn_subagent',
            description: 'Spawn a sub-agent to complete a specific task independently. The sub-agent has access to all the same tools (filesystem, shell, MCP, web, computer-use) and can run its own multi-step reasoning loop. Use this for complex subtasks that deserve their own focused attention.',
            input_schema: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'The specific task for the sub-agent to complete. Be precise about what to do and what to report back.' }
                },
                required: ['task']
            }
        }
    ];

    const mcpTools = (getMcpToolDefinitions() || []).map(openAiToAnthropicTool);
    const augustTools = (getAugustToolDefinitions() || []).map(openAiToAnthropicTool);
    const coworkTools = (getCoworkToolDefinitions() || []).map(openAiToAnthropicTool);

    const all = [
        ...coreWorkbenchTools,
        ...augustTools,
        ...mcpTools,
        ...coworkTools,
        ...hostAgent.toolDefinitions()
    ];

    const seen = new Set();
    return all.filter(tool => {
        if (seen.has(tool.name)) return false;
        seen.add(tool.name);
        return true;
    });
}

function toolDefinitions(session) {
    const allTools = getAllTools();
    const planActive = session.plan && session.approved;
    return planActive ? allTools : allTools;
}

function openAiToolDefinitions(session) {
    return toolDefinitions(session).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
        }
    }));
}

function requireApproval(session, toolName, args) {
    const rawMutating = ['workbench_write_file', 'workbench_replace_text', 'workbench_run_command',
        'august__write_file', 'august__bash', 'august__spawn_background_task',
        'mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__create_directory',
        'mcp__filesystem__move', 'mcp__filesystem__rename', 'mcp__filesystem__delete'];
    if (!rawMutating.includes(toolName) && !isProxyMutation(toolName, args || {})) return null;
    if (!isProxyMutation(toolName, args || {})) return null;
    if (session.plan && session.approved) return null;
    return {
        blocked: true,
        message: `WORKBENCH APPROVAL GATE — This mutation targets the proxy's own system files. Create a plan with workbench_submit_plan and wait for the user to approve it in the Workbench UI, then retry.`,
        detail: `Tool: ${toolName} | Arguments: ${JSON.stringify(args)}`
    };
}

function listDirectory(args) {
    const dir = resolveAnyPath(args.path || '.');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 100).map(entry => {
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        return {
            name: entry.name,
            path: toDisplayPath(fullPath),
            type: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other'),
            sizeBytes: stat.size
        };
    });
    return { root: toDisplayPath(dir), entries };
}

function readFile(args) {
    const filePath = resolveAnyPath(args.path);
    const maxChars = Math.max(1000, Math.min(80000, Number(args.max_chars || 20000)));
    const text = fs.readFileSync(filePath, 'utf8');
    return {
        path: toDisplayPath(filePath),
        length: text.length,
        truncated: text.length > maxChars,
        content: text.slice(0, maxChars)
    };
}

function walkFiles(root, limit = 800) {
    const results = [];
    const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);
    function walk(dir) {
        if (results.length >= limit) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(fullPath);
            else if (entry.isFile()) results.push(fullPath);
            if (results.length >= limit) return;
        }
    }
    walk(root);
    return results;
}

function searchFiles(args) {
    const root = resolveAnyPath(args.path || '.');
    const query = String(args.query || '');
    const limit = Math.max(1, Math.min(100, Number(args.limit || 50)));
    const matches = [];
    for (const filePath of walkFiles(root)) {
        let text = '';
        try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) { continue; }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                matches.push({ path: toDisplayPath(filePath), line: i + 1, text: lines[i].slice(0, 300) });
                if (matches.length >= limit) return { query, matches };
            }
        }
    }
    return { query, matches };
}

function submitPlan(session, args) {
    session.plan = {
        id: newId('plan'),
        summary: String(args.summary || '').trim(),
        steps: Array.isArray(args.steps) ? args.steps.map(String).filter(Boolean) : [],
        files: Array.isArray(args.files) ? args.files.map(String).filter(Boolean) : [],
        risks: Array.isArray(args.risks) ? args.risks.map(String).filter(Boolean) : [],
        verification: Array.isArray(args.verification) ? args.verification.map(String).filter(Boolean) : [],
        createdAt: new Date().toISOString()
    };
    session.approved = false;
    return {
        status: 'plan_submitted_waiting_for_user_approval',
        plan: session.plan,
        hardRule: 'Do not write files or run commands until the user approves this plan in the Workbench UI.'
    };
}

function writeFile(args) {
    const filePath = resolveAnyPath(args.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(args.content || ''), 'utf8');
    return { status: 'written', path: toDisplayPath(filePath), bytes: Buffer.byteLength(String(args.content || ''), 'utf8') };
}

function replaceText(args) {
    const filePath = resolveAnyPath(args.path);
    const text = fs.readFileSync(filePath, 'utf8');
    const find = String(args.find || '');
    if (!find) throw new Error('find text is required.');
    if (!text.includes(find)) throw new Error(`Text to replace was not found in ${toDisplayPath(filePath)}.`);
    const next = text.replace(find, String(args.replace || ''));
    fs.writeFileSync(filePath, next, 'utf8');
    return { status: 'replaced', path: toDisplayPath(filePath), replacements: 1 };
}

function runCommand(args) {
    return new Promise(resolve => {
        const timeout = Math.max(1000, Math.min(120000, Number(args.timeout_ms || 30000)));
        execFile(process.platform === 'win32' ? 'powershell.exe' : 'sh', process.platform === 'win32'
            ? ['-NoProfile', '-Command', String(args.command || '')]
            : ['-lc', String(args.command || '')], {
            cwd: WORKSPACE_ROOT,
            timeout,
            maxBuffer: 1024 * 1024
        }, (error, stdout, stderr) => {
            resolve({
                status: error ? 'error' : 'ok',
                exitCode: error?.code ?? 0,
                stdout: String(stdout || '').slice(-20000),
                stderr: String(stderr || '').slice(-20000)
            });
        });
    });
}

async function executeSubAgent(session, args) {
    const task = String(args.task || '').trim();
    if (!task) return { status: 'error', message: 'No task provided for sub-agent.' };
    const profile = getProfile(session.provider === 'codex' ? 'codex' : 'claude') || {};
    const targetUrl = session.provider === 'codex' ? normalizeOpenAiTargetUrl(profile) : profile.targetUrl;
    const model = profile._upstreamModel || profile.currentModel || 'claude-opus-4-6';
    if (!targetUrl) return { status: 'error', message: 'Provider target URL missing.' };

    const subPrompt = [
        'You are a focused sub-agent spawned by the main AI Workbench agent.',
        'Your task is: ' + task,
        'You have access to the same tools (filesystem, shell, MCP, web, computer-use).',
        'Complete the task efficiently and report your findings back to the parent agent.',
        'Keep your response concise — focus on results.'
    ].join('\n');

    const subMessages = [{ role: 'user', content: task }];
    let subResult = '';
    let subLoops = 0;
    while (subLoops < 4) {
        subLoops++;
        try {
            const headers = session.provider === 'codex'
                ? { 'Content-Type': 'application/json', ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}) }
                : buildHeaders(profile.apiKey);
            const body = session.provider === 'codex'
                ? { model, messages: [{ role: 'system', content: subPrompt }, ...subMessages], tools: openAiToolDefinitions(session), tool_choice: 'auto', stream: false }
                : { model, max_tokens: 1024, system: subPrompt, messages: subMessages, tools: toolDefinitions(session) };

            const res = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
            const raw = await res.text();
            if (!res.ok) return { status: 'error', message: `Sub-agent upstream error: ${raw.slice(0, 300)}` };
            const data = JSON.parse(raw);
            const content = session.provider === 'codex'
                ? openAiMessageToAnthropicContent(data.choices?.[0]?.message || {})
                : (Array.isArray(data.content) ? data.content : []);

            subMessages.push({ role: 'assistant', content });
            const text = extractAssistantText(content);
            if (text) subResult = text;

            const toolUses = content.filter(b => b.type === 'tool_use');
            if (!toolUses.length) break;

            const results = [];
            for (const tu of toolUses) {
                try {
                    const result = await executeWorkbenchTool(session, tu);
                    results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result, null, 2), is_error: !!result.blocked });
                } catch (e) {
                    results.push({ type: 'tool_result', tool_use_id: tu.id, content: `[Sub-agent Tool Error] ${e.message}`, is_error: true });
                }
            }
            subMessages.push({ role: 'user', content: results });
        } catch (e) {
            return { status: 'error', message: `Sub-agent error: ${e.message}` };
        }
    }
    return { status: 'ok', task, result: subResult || '(no text output)' };
}

async function executeWorkbenchTool(session, toolUse) {
    const name = toolUse.name;
    const args = toolUse.input || {};
    const blocked = requireApproval(session, name, args);
    if (blocked) return blocked;

    if (name === 'workbench_list_directory') return listDirectory(args);
    if (name === 'workbench_read_file') return readFile(args);
    if (name === 'workbench_search_files') return searchFiles(args);
    if (name === 'workbench_submit_plan') return submitPlan(session, args);
    if (name === 'workbench_write_file') return writeFile(args);
    if (name === 'workbench_replace_text') return replaceText(args);
    if (name === 'workbench_run_command') return runCommand(args);
    if (name === 'workbench_spawn_subagent') return executeSubAgent(session, args);
    if (name.startsWith('computer_')) return hostAgent.execute(name, args);
    if (isMcpToolName(name)) return executeMcpToolCall(name, args);
    if (isAugustToolName(name)) return executeAugustToolCall(name, args);
    if (isCoworkToolName(name)) return executeCoworkToolCall(name, args);
    if (isManagedWebToolName(name)) return executeManagedWebTool(name, args);
    throw new Error(`Unsupported workbench tool: ${name}`);
}

function buildSystemPrompt(session) {
    const planLine = session.plan && session.approved
        ? `The user approved plan ${session.plan.id}. You may now modify proxy system files.`
        : 'No approved plan is active. Mutations to the proxy system directory are blocked.';

    const toolGuide = [
        '',
        '=== AVAILABLE TOOL CATEGORIES ===',
        '- workbench_*: List/read/search/write files, replace text, run commands, submit plans (anywhere on system)',
        '- august__*: Shell execution (august__bash), file I/O, semantic memory (remember/recall/list/forget), specialists, supermemory, background tasks, sub-agents (spawn_subagent, learn_subagent)',
        '- mcp__*: All tools from connected MCP servers (filesystem, minimax, fetch, custom servers)',
        '- WebSearch / WebFetch: Public web search and page fetching',
        '- mcp__cowork__*: Cowork compatibility tools (directory access, skills, plugins, import capability links)',
        '- computer_*: Host desktop control — screenshot, mouse (move/click/scroll), keyboard (type/key), window list/focus, app launch, visible browser',
        'Keep responses concise and report what you did or found.'
    ].join('\n');

    const hardRule = [
        '',
        '=== HARD RULE: PROXY SYSTEM PROTECTION ===',
        'You can freely read, search, and modify files ANYWHERE on the system — with one exception:',
        'Any mutation targeting the proxy\'s own directory (claudish-proxy/) requires an explicit approved plan via workbench_submit_plan and user approval in the Workbench UI.',
        'The proxy system directory contains: ' + PROXY_ROOT,
        'If a file path or command references a file inside this directory and it is a write/edit/delete/rename/move/create operation, it will be blocked without an approved plan.',
        'Operations OUTSIDE the proxy system directory work freely — no approval needed.',
        planLine
    ].join('\n');

    // Build shared context blocks via context-builder (same as regular API path)
    const basePrompt = buildSystemPromptText(null, {
        includeMiniMaxContract: false,
        includeWindowsContext: true,
        includeOriginalSystem: false,
        clientId: 'workbench-ui'
    });

    return basePrompt + hardRule + toolGuide;
}

function extractAssistantText(content = []) {
    return content.filter(block => block.type === 'text').map(block => block.text || '').join('\n').trim();
}

function buildHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
}

async function callWorkbenchModel(session) {
    return session.provider === 'codex' ? callOpenAiWorkbenchModel(session) : callAnthropicWorkbenchModel(session);
}

async function callAnthropicWorkbenchModel(session) {
    const profile = getProfile('claude') || {};
    if (!profile.targetUrl) throw new Error('Claude profile target URL is missing.');
    const model = profile._upstreamModel || profile.currentModel || 'claude-opus-4-6';

    const events = [];
    let loops = 0;
    while (loops < MAX_TOOL_LOOPS) {
        loops++;
        const response = await fetch(profile.targetUrl, {
            method: 'POST',
            headers: buildHeaders(profile.apiKey),
            body: JSON.stringify({
                model,
                max_tokens: 2048,
                system: buildSystemPrompt(session),
                messages: session.messages,
                tools: toolDefinitions(session)
            }),
            signal: AbortSignal.timeout(300000)
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(`Workbench upstream error ${response.status}: ${raw.slice(0, 500)}`);
        const data = JSON.parse(raw);
        const content = Array.isArray(data.content) ? data.content : [];
        session.messages.push({ role: 'assistant', content });

        content.forEach(block => {
            if (block.type === 'text') events.push({ type: 'text', content: block.text });
            else if (block.type === 'thinking') events.push({ type: 'thinking', content: block.thinking });
            else if (block.type === 'tool_use') events.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        });

        const toolUses = content.filter(block => block.type === 'tool_use');
        if (!toolUses.length) {
            session.updatedAt = new Date().toISOString();
            return { session: summarizeSession(session), assistant: extractAssistantText(content), content, events };
        }

        const results = [];
        for (const toolUse of toolUses) {
            try {
                const result = await executeWorkbenchTool(session, toolUse);
                results.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(result, null, 2),
                    is_error: !!result.blocked
                });
            } catch (e) {
                results.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: `[Workbench Tool Error] ${e.message}`,
                    is_error: true
                });
            }
        }
        results.forEach(r => events.push({ type: 'tool_result', id: r.tool_use_id, content: r.content, is_error: r.is_error }));
        session.messages.push({ role: 'user', content: results });
    }

    session.updatedAt = new Date().toISOString();
    return {
        session: summarizeSession(session),
        assistant: 'Workbench stopped after the maximum tool loop count. Review the current plan or send a narrower request.',
        content: [],
        events
    };
}

function toOpenAiMessages(messages) {
    return messages.flatMap(message => {
        if (message.role === 'user' && typeof message.content === 'string') {
            return [{ role: 'user', content: message.content }];
        }
        if (message.role === 'assistant' && Array.isArray(message.content)) {
            const text = extractAssistantText(message.content);
            const toolUses = message.content.filter(block => block.type === 'tool_use');
            return [{
                role: 'assistant',
                content: text || null,
                tool_calls: toolUses.length ? toolUses.map(toolUse => ({
                    id: toolUse.id,
                    type: 'function',
                    function: {
                        name: toolUse.name,
                        arguments: JSON.stringify(toolUse.input || {})
                    }
                })) : undefined
            }];
        }
        if (message.role === 'user' && Array.isArray(message.content)) {
            return message.content
                .filter(block => block.type === 'tool_result')
                .map(block => ({
                    role: 'tool',
                    tool_call_id: block.tool_use_id,
                    content: block.content || ''
                }));
        }
        return [];
    });
}

function openAiMessageToAnthropicContent(message = {}) {
    const content = [];
    if (message.content) content.push({ type: 'text', text: String(message.content) });
    (message.tool_calls || []).forEach(toolCall => {
        let input = {};
        try { input = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { input = {}; }
        content.push({
            type: 'tool_use',
            id: toolCall.id || newId('toolu'),
            name: toolCall.function?.name,
            input
        });
    });
    return content;
}

function normalizeOpenAiTargetUrl(profile) {
    const target = String(profile.targetUrl || '').trim();
    if (!target) return '';
    if (/\/chat\/completions$/i.test(target)) return target;
    return target.replace(/\/+$/, '').replace(/\/models$/i, '') + '/chat/completions';
}

async function callOpenAiWorkbenchModel(session) {
    const profile = getProfile('codex') || {};
    const targetUrl = normalizeOpenAiTargetUrl(profile);
    if (!targetUrl) throw new Error('Codex profile target URL is missing.');
    const model = profile._upstreamModel || profile.currentModel || 'gpt-4o';

    const events = [];
    let loops = 0;
    while (loops < MAX_TOOL_LOOPS) {
        loops++;
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {})
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: buildSystemPrompt(session) },
                    ...toOpenAiMessages(session.messages)
                ],
                tools: openAiToolDefinitions(session),
                tool_choice: 'auto',
                stream: false
            }),
            signal: AbortSignal.timeout(300000)
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(`Workbench upstream error ${response.status}: ${raw.slice(0, 500)}`);
        const data = JSON.parse(raw);
        const message = data.choices?.[0]?.message || {};
        const content = openAiMessageToAnthropicContent(message);
        session.messages.push({ role: 'assistant', content });

        content.forEach(block => {
            if (block.type === 'text') events.push({ type: 'text', content: block.text });
            else if (block.type === 'thinking') events.push({ type: 'thinking', content: block.thinking });
            else if (block.type === 'tool_use') events.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        });

        const toolUses = content.filter(block => block.type === 'tool_use');
        if (!toolUses.length) {
            session.updatedAt = new Date().toISOString();
            return { session: summarizeSession(session), assistant: extractAssistantText(content), content, events };
        }

        const results = [];
        for (const toolUse of toolUses) {
            try {
                const result = await executeWorkbenchTool(session, toolUse);
                results.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(result, null, 2),
                    is_error: !!result.blocked
                });
            } catch (e) {
                results.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: `[Workbench Tool Error] ${e.message}`,
                    is_error: true
                });
            }
        }
        results.forEach(r => events.push({ type: 'tool_result', id: r.tool_use_id, content: r.content, is_error: r.is_error }));
        session.messages.push({ role: 'user', content: results });
    }

    session.updatedAt = new Date().toISOString();
    return {
        session: summarizeSession(session),
        assistant: 'Workbench stopped after the maximum tool loop count. Review the current plan or send a narrower request.',
        content: [],
        events
    };
}

async function sendWorkbenchMessage({ sessionId, message, provider } = {}) {
    const session = getWorkbenchSession(sessionId);
    if (provider === 'claude' || provider === 'codex') session.provider = provider;
    const text = String(message || '').trim();
    if (!text) throw new Error('Message is required.');
    session.messages.push({ role: 'user', content: text });
    session.updatedAt = new Date().toISOString();
    return callWorkbenchModel(session);
}

function approveWorkbenchPlan(sessionId) {
    const session = getWorkbenchSession(sessionId);
    if (!session.plan) throw new Error('No submitted plan is waiting for approval.');
    session.approved = true;
    session.updatedAt = new Date().toISOString();
    return summarizeSession(session);
}

function resetWorkbenchSession(sessionId, provider) {
    if (sessionId) sessions.delete(sessionId);
    return createWorkbenchSession({ provider });
}

module.exports = {
    WORKSPACE_ROOT,
    approveWorkbenchPlan,
    createWorkbenchSession,
    executeWorkbenchTool,
    getWorkbenchSession,
    resetWorkbenchSession,
    sendWorkbenchMessage,
    summarizeSession
};

