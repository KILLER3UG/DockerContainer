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
const { executeManagedWebTool, isManagedWebToolName, getManagedWebToolDefinitions } = require('./local-web');
const { extractAndSaveMemories } = require('./auto-memory');
const { getBrainDiagnostics } = require('./brain-diagnostics');
const { getCapabilityHealth } = require('./health');
const { getActivityLog, getPendingRequests, getRequestLog, getStats } = require('./logger');
const { findSkillSources, importSkillFromLink, previewSkillImport } = require('./skill-importer');
const {
    deriveChildAgentPermissions,
    evaluateAgentTool,
    getAgent,
    getAgents,
    renderAgentContext
} = require('./agent-registry');

const sessions = new Map();
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(WORKSPACE_ROOT, '..');
const CONTAINER_PROJECT_ROOT = path.resolve(process.env.CLAUDISH_PROXY_CONTAINER_ROOT || PROJECT_ROOT);
const LEGACY_HOST_PROJECT_ROOTS = [
    'C:\\Users\\rober\\LocalFolders\\DockerContainer\\claudish-proxy'
];
const MAX_TOOL_LOOPS = Infinity;
const COMPACT_THRESHOLD = 60;      // compact messages after this many entries
const COMPACT_KEEP_RECENT = 12;    // keep last N messages verbatim
const DRIFT_INTERVAL = 8;          // inject identity reminder every N tool-result turns
const MAX_RETRIES = 2;             // upstream fetch retry count
const GOAL_CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

function splitConfiguredRoots(value) {
    return String(value || '')
        .split(/[;|]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function uniquePaths(paths) {
    const seen = new Set();
    const result = [];
    for (const item of paths.filter(Boolean)) {
        const key = normalizeForCompare(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function normalizeForCompare(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

const HOST_PROJECT_ROOTS = uniquePaths([
    ...splitConfiguredRoots(process.env.CLAUDISH_PROXY_HOST_ROOTS),
    ...splitConfiguredRoots(process.env.CLAUDISH_PROXY_HOST_ROOT),
    ...splitConfiguredRoots(process.env.CLAUDISH_HOST_ROOT),
    PROJECT_ROOT,
    ...LEGACY_HOST_PROJECT_ROOTS
]);

function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveAgentId(agentId, fallback = 'build') {
    const id = String(agentId || '').trim();
    if (id && getAgents().some(agent => agent.id === id)) return id;
    return fallback;
}

function createWorkbenchSession({ provider = 'claude', agentId = 'build' } = {}) {
    const resolvedAgentId = resolveAgentId(agentId, 'build');
    const session = {
        id: newId('wb'),
        provider: provider === 'codex' ? 'codex' : 'claude',
        agentId: resolvedAgentId,
        parentAgentId: null,
        inheritedPermissions: null,
        messages: [],
        plan: null,
        approved: false,
        approvedAt: null,
        goal: null,
        lastGoal: null,
        mutationLog: [],
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
    const agent = getAgent(session.agentId || 'build');
    return {
        id: session.id,
        provider: session.provider,
        agentId: agent.id,
        agentRole: agent.role,
        agentMode: agent.mode,
        approved: session.approved,
        approvedAt: session.approvedAt,
        plan: session.plan,
        goal: summarizeGoal(session.goal),
        lastGoal: summarizeGoal(session.lastGoal),
        messageCount: session.messages.length,
        mutationCount: Array.isArray(session.mutationLog) ? session.mutationLog.length : 0,
        lastMutationAt: Array.isArray(session.mutationLog) && session.mutationLog.length
            ? session.mutationLog[session.mutationLog.length - 1].at
            : null,
        updatedAt: session.updatedAt
    };
}

function summarizeGoal(goal) {
    if (!goal) return null;
    return {
        id: goal.id,
        condition: goal.condition,
        status: goal.status,
        startedAt: goal.startedAt,
        updatedAt: goal.updatedAt,
        achievedAt: goal.achievedAt || null,
        clearedAt: goal.clearedAt || null,
        turns: Number(goal.turns || 0),
        lastReason: goal.lastReason || null,
        lastMet: goal.lastMet === true
    };
}

function setWorkbenchGoal(session, condition) {
    const clean = String(condition || '').trim();
    if (!clean) throw new Error('Goal condition is required.');
    if (clean.length > 4000) throw new Error('Goal condition must be 4000 characters or less.');
    const now = new Date().toISOString();
    session.goal = {
        id: newId('goal'),
        condition: clean,
        status: 'active',
        startedAt: now,
        updatedAt: now,
        turns: 0,
        lastReason: 'Goal started. Waiting for the first turn to finish before evaluation.',
        lastMet: false
    };
    session.updatedAt = now;
    return summarizeGoal(session.goal);
}

function clearWorkbenchGoal(session, reason = 'cleared') {
    if (!session.goal) return summarizeGoal(session.lastGoal);
    const now = new Date().toISOString();
    session.goal.status = 'cleared';
    session.goal.clearedAt = now;
    session.goal.updatedAt = now;
    session.goal.lastReason = reason || 'cleared';
    session.lastGoal = session.goal;
    session.goal = null;
    session.updatedAt = now;
    return summarizeGoal(session.lastGoal);
}

function mapHostPath(inputPath) {
    const raw = String(inputPath || '').trim();
    if (!raw) return WORKSPACE_ROOT;
    const normalizedRaw = normalizeForCompare(raw);
    for (const hostRoot of HOST_PROJECT_ROOTS) {
        const normalizedHost = normalizeForCompare(hostRoot);
        if (normalizedRaw === normalizedHost || normalizedRaw.startsWith(`${normalizedHost}/`)) {
            const suffix = raw.replace(/\\/g, '/')
                .slice(String(hostRoot).replace(/\\/g, '/').replace(/\/+$/, '').length)
                .replace(/^\/+/, '');
            return path.join(CONTAINER_PROJECT_ROOT, suffix);
        }
    }
    return raw;
}

function resolveAnyPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return WORKSPACE_ROOT;
    const mapped = mapHostPath(inputPath);
    const resolved = path.isAbsolute(mapped)
        ? path.resolve(mapped)
        : path.resolve(PROJECT_ROOT, mapped);
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

function toolNameLooksMutating(toolName) {
    return /write|edit|create|move|rename|delete|remove|install|import|save|set|update|add|forget|remember|bash|command|run|spawn|launch|click|type|focus|clipboard_set/i.test(String(toolName || ''));
}

function isProxyMutation(toolName, args) {
    if (!toolNameLooksMutating(toolName)) return false;
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

const MUTATING_WORKBENCH_TOOLS = new Set([
    'workbench_write_file',
    'workbench_replace_text',
    'workbench_run_command',
    'august__write_file',
    'august__bash',
    'august__spawn_background_task',
    'august__remember',
    'august__forget',
    'august__learn_subagent',
    'august__import_skill',
    'workbench_import_skill',
    'computer_mouse_click',
    'computer_mouse_double_click',
    'computer_mouse_right_click',
    'computer_type',
    'computer_key',
    'computer_focus_window',
    'computer_launch',
    'computer_open_browser',
    'computer_close_browser',
    'computer_clipboard_set'
]);

const SAFE_COMPUTER_TOOLS = new Set([
    'computer_screenshot',
    'computer_mouse_move',
    'computer_mouse_position',
    'computer_screen_size',
    'computer_list_windows',
    'computer_clipboard_get'
]);

function isMutatingWorkbenchTool(toolName, args) {
    if (MUTATING_WORKBENCH_TOOLS.has(toolName)) return true;
    if (toolName?.startsWith('computer_')) return !SAFE_COMPUTER_TOOLS.has(toolName);
    if (isProxyMutation(toolName, args || {})) return true;
    if (toolName?.startsWith('mcp__filesystem__')) {
        return /write|edit|create|move|rename|delete|remove/i.test(toolName);
    }
    if (toolName?.startsWith('mcp__')) {
        return /write|edit|create|move|rename|delete|remove|install|import|save|set|update|add|forget|remember/i.test(toolName);
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
            name: 'workbench_diagnose_proxy',
            description: 'Run a non-mutating self-diagnostic for the proxy, August Brain, vector DB, semantic memory, Supermemory configuration, providers, MCP, and recent activity.',
            input_schema: {
                type: 'object',
                properties: {
                    include_activity: { type: 'boolean', description: 'Include recent request/activity summaries. Defaults to true.' }
                }
            }
        },
        {
            name: 'workbench_describe_environment',
            description: 'Describe the Workbench runtime roots, host-to-container path mappings, provider mode, approval state, and recent mutation audit without changing anything.',
            input_schema: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'workbench_list_proxy_capabilities',
            description: 'List every tool and capability currently exposed to AI Workbench, grouped by source.',
            input_schema: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'workbench_list_agent_registry',
            description: 'List the Workbench agent registry, default roles, and parent-to-child inherited permissions.',
            input_schema: {
                type: 'object',
                properties: {
                    parent_agent_id: { type: 'string', description: 'Parent agent whose permissions should be used for inheritance. Defaults to the current session agent.' }
                }
            }
        },
        {
            name: 'workbench_get_activity',
            description: 'Read recent proxy activity, pending requests, and request stats without mutating anything.',
            input_schema: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Number of recent request log entries to return. Defaults to 10.' }
                }
            }
        },
        {
            name: 'workbench_submit_plan',
            description: 'Submit an implementation plan for user review. Required BEFORE any mutation anywhere on the system.',
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
            name: 'workbench_find_skill_sources',
            description: 'Search for importable skills/capabilities from GitHub or preview a direct GitHub/raw/http URL. This is read-only; use it before importing skills from the internet.',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Skill topic, capability name, or direct public URL.' },
                    url: { type: 'string', description: 'Direct GitHub/raw/http URL to resolve instead of searching.' },
                    limit: { type: 'number', description: 'Maximum GitHub candidates. Defaults to 5.' },
                    verify: { type: 'boolean', description: 'When true, preview the first one or two candidates. Defaults to false.' },
                    enable_mcp: { type: 'boolean', description: 'Preview imported MCP servers as enabled. Defaults to false.' }
                }
            }
        },
        {
            name: 'workbench_preview_skill_import',
            description: 'Preview what a GitHub/raw/http capability link would save as skills, MCP servers, and plugins. This does not write anything.',
            input_schema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'GitHub repo/blob, raw URL, plugin manifest, MCP config, package metadata, pyproject.toml, or SKILL.md URL.' },
                    enable_mcp: { type: 'boolean', description: 'Preview imported MCP servers as enabled. Defaults to false.' }
                },
                required: ['url']
            }
        },
        {
            name: 'workbench_import_skill',
            description: 'Import and save a skill/capability from a GitHub/raw/http link into the global August skill catalog. Requires an approved plan first. Saved skills become available to Workbench, Claude Code, Hermes, Codex, and other proxy clients on the next request.',
            input_schema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'GitHub repo/blob, raw URL, plugin manifest, MCP config, package metadata, pyproject.toml, or SKILL.md URL.' },
                    enable_mcp: { type: 'boolean', description: 'Enable imported MCP servers immediately. Defaults to false for safety.' },
                    restart_mcp: { type: 'boolean', description: 'Restart MCP servers after enabling imported MCP servers. Defaults to true.' }
                },
                required: ['url']
            }
        },
        {
            name: 'workbench_write_file',
            description: 'Write a complete file anywhere on the filesystem. Requires an approved plan first.',
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
            description: 'Replace exact text inside any file. Requires an approved plan first.',
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
            description: 'Run a PowerShell command in the workspace root. Requires an approved plan first.',
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
            description: 'Spawn a focused sub-agent to complete a specific task independently. Choose explore for read-only codebase questions, plan for architecture/planning, or general for bounded research. The child inherits the parent agent permissions and approval policy.',
            input_schema: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', enum: ['build', 'plan', 'explore', 'general'], description: 'Agent profile. Defaults to general for delegated work.' },
                    parent_agent_id: { type: 'string', description: 'Optional parent agent override for permission inheritance. Defaults to the current session agent.' },
                    task: { type: 'string', description: 'The specific task for the sub-agent to complete. Be precise about what to do and what to report back.' }
                },
                required: ['task']
            }
        }
    ];

    const mcpTools = (getMcpToolDefinitions() || []).map(openAiToAnthropicTool);
    const augustTools = (getAugustToolDefinitions() || []).map(openAiToAnthropicTool);
    const coworkTools = (getCoworkToolDefinitions() || []).map(openAiToAnthropicTool);
    const webTools = (getManagedWebToolDefinitions() || []).map(openAiToAnthropicTool);

    const all = [
        ...coreWorkbenchTools,
        ...augustTools,
        ...mcpTools,
        ...coworkTools,
        ...webTools,
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
    return allTools;
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
    if (!isMutatingWorkbenchTool(toolName, args || {})) return null;
    if (session.plan && session.approved) return null;
    return {
        blocked: true,
        message: 'WORKBENCH APPROVAL GATE - This operation can update files, run commands, change memory, control the host desktop, or otherwise change system state. Create a plan with workbench_submit_plan and wait for the user to approve it in the Workbench UI or August terminal /approve, then retry.',
        detail: `Tool: ${toolName} | Arguments: ${JSON.stringify(args)}`
    };
}

function requireAgentPermission(session, toolName, args, toolContext = {}) {
    const agentId = resolveAgentId(toolContext.agentId || session?.agentId || 'build', 'build');
    const inheritedPermissions = toolContext.inheritedPermissions || session?.inheritedPermissions || null;
    const decision = evaluateAgentTool(agentId, toolName, inheritedPermissions);
    if (decision.action !== 'deny') return null;
    return {
        blocked: true,
        message: 'AGENT PERMISSION GUARD - This agent profile is not allowed to use that category of tool. Use a different agent, spawn an allowed child, or ask the build agent to submit an approved plan for the mutation.',
        detail: [
            `Agent: ${agentId}`,
            toolContext.parentAgentId ? `Parent: ${toolContext.parentAgentId}` : null,
            `Tool: ${toolName}`,
            `Category: ${decision.category}`,
            `Arguments: ${JSON.stringify(args)}`
        ].filter(Boolean).join(' | ')
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
    session.approvedAt = null;
    return {
        status: 'plan_submitted_waiting_for_user_approval',
        plan: session.plan,
        hardRule: 'Do not write files or run commands until the user approves this plan in the Workbench UI or August terminal /approve.'
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

function groupToolName(name) {
    if (name.startsWith('workbench_')) return 'workbench';
    if (name.startsWith('august__')) return 'august';
    if (name.startsWith('mcp__workspace__web_') || name === 'WebSearch' || name === 'WebFetch' || name.startsWith('web_')) return 'web';
    if (name.startsWith('mcp__cowork__')) return 'cowork';
    if (name.startsWith('mcp__')) return 'mcp';
    if (name.startsWith('computer_')) return 'computer';
    return 'other';
}

function listProxyCapabilities() {
    const tools = getAllTools();
    const groups = {};
    for (const tool of tools) {
        const group = groupToolName(tool.name);
        if (!groups[group]) groups[group] = [];
        groups[group].push({
            name: tool.name,
            mutating: isMutatingWorkbenchTool(tool.name, {}),
            description: tool.description || ''
        });
    }
    return {
        generatedAt: new Date().toISOString(),
        totalTools: tools.length,
        groups,
        agents: listAgentRegistry('build'),
        approvalGate: {
            readSearchInspectAllowed: true,
            mutationsRequireApprovedPlan: true
        }
    };
}

function listAgentRegistry(parentAgentId = 'build') {
    const activeAgentId = resolveAgentId(parentAgentId, 'build');
    const agents = getAgents().map(agent => {
        const effectivePermissions = agent.id === activeAgentId
            ? agent.permissions
            : deriveChildAgentPermissions(activeAgentId, agent.id);
        return {
            id: agent.id,
            role: agent.role,
            mode: agent.mode,
            goal: agent.goal,
            memoryEnabled: agent.memory_enabled !== false,
            allowDelegation: agent.allow_delegation === true,
            tools: agent.tools || [],
            permissions: agent.permissions || {},
            inheritedFrom: agent.id === activeAgentId ? null : activeAgentId,
            effectivePermissions
        };
    });
    return {
        generatedAt: new Date().toISOString(),
        activeAgentId,
        agents,
        inheritance: {
            rule: 'Child agent permissions are the most restrictive merge of parent and child. deny beats ask; ask beats allow.',
            parentAgentId: activeAgentId
        }
    };
}

function getWorkbenchActivity(args = {}) {
    const limit = Math.max(1, Math.min(50, Number(args.limit || 10)));
    return {
        generatedAt: new Date().toISOString(),
        activity: getActivityLog().slice(0, limit),
        pending: getPendingRequests(),
        stats: getStats('all'),
        recentRequests: getRequestLog().slice(0, limit)
    };
}

function describeWorkbenchEnvironment(session) {
    return {
        generatedAt: new Date().toISOString(),
        provider: session?.provider || 'claude',
        roots: {
            projectRoot: PROJECT_ROOT,
            workspaceRoot: WORKSPACE_ROOT,
            containerProjectRoot: CONTAINER_PROJECT_ROOT,
            hostProjectRoots: HOST_PROJECT_ROOTS
        },
        pathMapping: {
            envVars: [
                'CLAUDISH_PROXY_HOST_ROOTS',
                'CLAUDISH_PROXY_HOST_ROOT',
                'CLAUDISH_HOST_ROOT',
                'CLAUDISH_PROXY_CONTAINER_ROOT'
            ],
            hostRootsMapTo: CONTAINER_PROJECT_ROOT,
            note: 'Host project paths are mapped to the container project root before file tools run, so pasted Windows paths and in-container paths resolve to the same project tree.'
        },
        approvalGate: {
            approved: session?.approved === true,
            approvedAt: session?.approvedAt || null,
            activePlanId: session?.plan?.id || null,
            mutationsRequireApprovedPlan: true
        },
        agent: {
            id: session?.agentId || 'build',
            role: getAgent(session?.agentId || 'build').role,
            parentAgentId: session?.parentAgentId || null,
            inheritedPermissions: session?.inheritedPermissions || null
        },
        mutationAudit: Array.isArray(session?.mutationLog)
            ? session.mutationLog.slice(-10)
            : []
    };
}

function diagnoseProxy(args = {}) {
    const includeActivity = args.include_activity !== false;
    const capabilityHealth = getCapabilityHealth();
    const brain = getBrainDiagnostics();
    const capabilityInventory = listProxyCapabilities();
    const activity = includeActivity ? getWorkbenchActivity({ limit: 8 }) : null;
    const recommendedActions = [
        ...capabilityHealth.checks,
        ...brain.checks
    ]
        .filter(check => check.status !== 'ok' && check.action)
        .map(check => ({
            id: check.id,
            area: check.area,
            status: check.status,
            action: check.action,
            detail: check.detail
        }));

    return {
        generatedAt: new Date().toISOString(),
        status: capabilityHealth.summary.overall === 'error' || brain.summary.overall === 'error'
            ? 'error'
            : (capabilityHealth.summary.overall === 'warn' || brain.summary.overall === 'warn' ? 'warn' : 'ok'),
        health: capabilityHealth,
        brain,
        capabilities: capabilityInventory,
        activity,
        recommendedActions
    };
}

async function executeSubAgent(session, args) {
    const task = String(args.task || '').trim();
    if (!task) return { status: 'error', message: 'No task provided for sub-agent.' };
    const parentAgentId = resolveAgentId(args.parent_agent_id || session?.agentId || 'build', 'build');
    const requestedAgentId = String(args.agent_id || args.agent || args.subagent_type || 'general').trim();
    const childAgentId = getAgents().some(agent => agent.id === requestedAgentId)
        ? requestedAgentId
        : 'general';
    const childAgent = getAgent(childAgentId);
    const inheritedPermissions = deriveChildAgentPermissions(parentAgentId, childAgentId);
    const profile = getProfile(session.provider === 'codex' ? 'codex' : 'claude') || {};
    const targetUrl = session.provider === 'codex' ? normalizeOpenAiTargetUrl(profile) : profile.targetUrl;
    const model = profile._upstreamModel || profile.currentModel || 'claude-opus-4-6';
    if (!targetUrl) return { status: 'error', message: 'Provider target URL missing.' };

    const subPrompt = [
        'You are a focused sub-agent spawned by the main AI Workbench agent.',
        `Sub-agent profile: ${childAgent.id} (${childAgent.role}). Goal: ${childAgent.goal}`,
        `Parent agent profile: ${parentAgentId}. Your effective inherited permissions are: ${Object.entries(inheritedPermissions).map(([key, value]) => `${key}:${value}`).join(', ')}.`,
        'Your task is: ' + task,
        'You have access to the same registered tools, but the server enforces your inherited permissions before the approval gate.',
        'Read/search/explore freely when your profile permits it, but do not perform any mutation unless the parent session already has an approved plan and your inherited permissions allow that tool category.',
        'A mutation means writing/editing/deleting/moving files, running shell commands, changing memory, launching background tasks, or controlling the host desktop.',
        'If a mutation is required and approval is not active, stop and report the exact plan the parent should submit for user approval.',
        'For exploration tasks, report concrete evidence: exact files read, commands/tools used, key findings, and any limits or uncertainty.',
        'Do not claim comprehensive understanding unless the evidence supports it. Todo or task-list updates are internal state, not project file updates.',
        'Keep your response concise and actionable.'
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
                    const result = await executeWorkbenchTool(session, tu, {
                        agentId: childAgentId,
                        parentAgentId,
                        inheritedPermissions
                    });
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
    return {
        status: 'ok',
        task,
        agentId: childAgentId,
        parentAgentId,
        inheritedPermissions,
        result: subResult || '(no text output)'
    };
}

function summarizeMutationArgs(toolName, args = {}) {
    const summary = {};
    const pathFields = ['path', 'file_path', 'source', 'destination'];
    for (const field of pathFields) {
        if (args[field]) summary[field] = toDisplayPath(resolveAnyPath(args[field]));
    }
    if (args.command) summary.command = String(args.command).slice(0, 500);
    if (args.content !== undefined) summary.contentBytes = Buffer.byteLength(String(args.content), 'utf8');
    if (args.find !== undefined) summary.findBytes = Buffer.byteLength(String(args.find), 'utf8');
    if (args.replace !== undefined) summary.replaceBytes = Buffer.byteLength(String(args.replace), 'utf8');
    if (args.url) summary.url = String(args.url).slice(0, 500);
    if (args.enable_mcp !== undefined) summary.enableMcp = args.enable_mcp === true;
    if (toolName?.startsWith('computer_')) summary.computerAction = toolName;
    return summary;
}

function recordMutation(session, toolName, args, result) {
    if (!session) return;
    const at = new Date().toISOString();
    if (!Array.isArray(session.mutationLog)) session.mutationLog = [];
    session.mutationLog.push({
        at,
        toolName,
        planId: session.plan?.id || null,
        args: summarizeMutationArgs(toolName, args),
        status: result?.status || (result?.blocked ? 'blocked' : 'ok'),
        error: result?.error || null
    });
    if (session.mutationLog.length > 100) {
        session.mutationLog = session.mutationLog.slice(-100);
    }
    session.updatedAt = at;
}

async function executeWorkbenchTool(session, toolUse, toolContext = {}) {
    const name = toolUse.name;
    const args = toolUse.input || {};
    const mutating = isMutatingWorkbenchTool(name, args);
    const agentBlocked = requireAgentPermission(session, name, args, toolContext);
    if (agentBlocked) return agentBlocked;
    const blocked = requireApproval(session, name, args);
    if (blocked) return blocked;

    let result;
    try {
        if (name === 'workbench_list_directory') result = listDirectory(args);
        else if (name === 'workbench_read_file') result = readFile(args);
        else if (name === 'workbench_search_files') result = searchFiles(args);
        else if (name === 'workbench_diagnose_proxy') result = diagnoseProxy(args);
        else if (name === 'workbench_describe_environment') result = describeWorkbenchEnvironment(session);
        else if (name === 'workbench_list_proxy_capabilities') result = listProxyCapabilities();
        else if (name === 'workbench_list_agent_registry') result = listAgentRegistry(args.parent_agent_id || session?.agentId || 'build');
        else if (name === 'workbench_get_activity') result = getWorkbenchActivity(args);
        else if (name === 'workbench_submit_plan') result = submitPlan(session, args);
        else if (name === 'workbench_find_skill_sources') result = await findSkillSources({
            query: args.query,
            url: args.url,
            limit: args.limit,
            verify: args.verify === true,
            enableMcp: args.enable_mcp === true
        });
        else if (name === 'workbench_preview_skill_import') result = await previewSkillImport({
            url: args.url,
            enableMcp: args.enable_mcp === true
        });
        else if (name === 'workbench_import_skill') result = await importSkillFromLink({
            url: args.url,
            enableMcp: args.enable_mcp === true,
            restartMcp: args.restart_mcp !== false
        });
        else if (name === 'workbench_write_file') result = writeFile(args);
        else if (name === 'workbench_replace_text') result = replaceText(args);
        else if (name === 'workbench_run_command') result = await runCommand(args);
        else if (name === 'workbench_spawn_subagent') result = await executeSubAgent(session, args);
        else if (name.startsWith('computer_')) result = await hostAgent.execute(name, args);
        else if (isMcpToolName(name)) result = await executeMcpToolCall(name, args);
        else if (isAugustToolName(name)) result = await executeAugustToolCall(name, args);
        else if (isCoworkToolName(name)) result = await executeCoworkToolCall(name, args);
        else if (isManagedWebToolName(name)) result = await executeManagedWebTool(name, args);
        else throw new Error(`Unsupported workbench tool: ${name}`);
    } catch (e) {
        if (mutating) recordMutation(session, name, args, { status: 'error', error: e.message });
        throw e;
    }

    if (mutating) recordMutation(session, name, args, result);
    return result;
}

function buildSystemPrompt(session) {
    const planLine = session.plan && session.approved
        ? `The user approved plan ${session.plan.id}. You may now perform mutations that are covered by that approved plan.`
        : 'No approved plan is active. All mutations are blocked.';

    const toolGuide = [
        '',
        '=== AVAILABLE TOOL CATEGORIES ===',
        '- workbench_*: List/read/search files, inspect proxy health/activity/capabilities, write files, replace text, run commands, submit plans (anywhere on system)',
        '- workbench_list_agent_registry / workbench_spawn_subagent: Inspect agent roles or delegate focused subtasks with parent permission inheritance',
        '- august__*: Shell execution (august__bash), file I/O, semantic memory (remember/recall/list/forget), specialists, supermemory, background tasks, sub-agents (spawn_subagent, learn_subagent)',
        '- mcp__*: All tools from connected MCP servers (filesystem, minimax, fetch, custom servers)',
        '- WebSearch / WebFetch: Public web search and page fetching',
        '- workbench_find_skill_sources / workbench_preview_skill_import / workbench_import_skill: Discover, inspect, and save internet/GitHub skills into the shared proxy skill catalog',
        '- mcp__cowork__*: Cowork compatibility tools (directory access, skills, plugins, import capability links)',
        '- computer_*: Host desktop control — screenshot, mouse (move/click/scroll), keyboard (type/key), window list/focus, app launch, visible browser',
        'When the user asks what is wrong with the proxy, brain, tools, memory, or runtime, call workbench_diagnose_proxy before guessing.',
        'When path mapping, mounted roots, provider mode, approval state, or recent mutations matter, call workbench_describe_environment before guessing.',
        'Keep responses concise and report what you did or found.'
    ].join('\n');

    const activeAgent = getAgent(session.agentId || 'build');
    const agentGuide = [
        '',
        '=== AGENT REGISTRY ===',
        `Current agent: ${activeAgent.id} (${activeAgent.role}). Goal: ${activeAgent.goal}`,
        'When delegating, choose an agent intentionally: explore for read-only codebase investigation, plan for architecture/planning, general for bounded side work.',
        'Child agents inherit the parent permission policy. The most restrictive permission wins: deny beats ask; ask beats allow.',
        renderAgentContext()
    ].join('\n');

    const hardRule = [
        '',
        '=== HARD RULE: PLAN APPROVAL BEFORE MUTATION ===',
        'You can freely read files, search files, inspect directories, search/fetch the web, and use non-mutating discovery tools.',
        'When the user asks you to fetch or add a skill from GitHub or the internet, search or preview first. Then submit a concrete plan and wait for approval before importing.',
        'Any mutation anywhere on the system requires an explicit approved plan via workbench_submit_plan and user approval in the Workbench UI.',
        'A mutation means writing/editing/deleting/moving/creating files, running shell commands, changing memory, installing/importing/updating resources, launching background tasks, or using host computer controls that click/type/focus/launch/close/set clipboard.',
        'If a mutating tool is attempted without approval, the server will cancel it and return the approval-gate reminder.',
        'The proxy system directory is: ' + PROXY_ROOT,
        planLine
    ].join('\n');

    // Build shared context blocks via context-builder (same as regular API path)
    const profile = getProfile(session.provider === 'codex' ? 'codex' : 'claude') || {};
    const model = profile._upstreamModel || profile.currentModel;
    const targetUrl = session.provider === 'codex' ? normalizeOpenAiTargetUrl(profile) : profile.targetUrl;
    const basePrompt = buildSystemPromptText(null, {
        includeMiniMaxContract: true,
        includeWindowsContext: true,
        includeOriginalSystem: false,
        model,
        targetUrl,
        clientId: 'workbench-ui'
    });

    return basePrompt + hardRule + toolGuide + agentGuide;
}

function extractAssistantText(content = []) {
    return content.filter(block => block.type === 'text').map(block => block.text || '').join('\n').trim();
}

function summarizeToolBlock(block) {
    if (!block) return '';
    if (block.type === 'tool_use') {
        return `[tool_use ${block.name || 'unknown'} ${JSON.stringify(block.input || {}).slice(0, 500)}]`;
    }
    if (block.type === 'tool_result') {
        return `[tool_result ${block.tool_use_id || ''} ${(block.content || '').slice(0, 900)}]`;
    }
    if (block.type === 'thinking') {
        return `[thinking omitted]`;
    }
    return String(block.text || block.content || '').trim();
}

function renderConversationTranscript(messages = [], maxChars = 24000) {
    const lines = [];
    for (const message of messages.slice(-40)) {
        let text = '';
        if (typeof message.content === 'string') {
            text = message.content;
        } else if (Array.isArray(message.content)) {
            text = message.content
                .map(summarizeToolBlock)
                .filter(Boolean)
                .join('\n');
        }
        if (!text) continue;
        lines.push(`${message.role.toUpperCase()}:\n${text}`);
    }
    const transcript = lines.join('\n\n');
    return transcript.length > maxChars
        ? transcript.slice(transcript.length - maxChars)
        : transcript;
}

function parseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) {}
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (_) {}
    return null;
}

function extractOpenAiText(data) {
    return String(data?.choices?.[0]?.message?.content || '').trim();
}

async function callWorkbenchTextOnlyModel(session, { system, user, maxTokens = 768 } = {}) {
    const provider = session.provider === 'codex' ? 'codex' : 'claude';
    const profile = getProfile(provider) || {};
    const model = profile._upstreamModel || profile.currentModel || (provider === 'codex' ? 'gpt-4o' : 'claude-opus-4-6');
    const targetUrl = provider === 'codex' ? normalizeOpenAiTargetUrl(profile) : profile.targetUrl;
    if (!targetUrl) throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude'} profile target URL is missing.`);

    if (provider === 'codex') {
        const res = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {})
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: system || '' },
                    { role: 'user', content: user || '' }
                ],
                stream: false,
                max_tokens: maxTokens
            }),
            signal: AbortSignal.timeout(120000)
        });
        const raw = await res.text();
        if (!res.ok) throw new Error(`Workbench side model error ${res.status}: ${raw.slice(0, 500)}`);
        return extractOpenAiText(JSON.parse(raw));
    }

    const res = await fetch(targetUrl, {
        method: 'POST',
        headers: buildHeaders(profile.apiKey),
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: system || '',
            messages: [{ role: 'user', content: user || '' }]
        }),
        signal: AbortSignal.timeout(120000)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Workbench side model error ${res.status}: ${raw.slice(0, 500)}`);
    const data = JSON.parse(raw);
    return extractAssistantText(Array.isArray(data.content) ? data.content : []);
}

async function answerWorkbenchBtw({ sessionId, question, provider, agentId } = {}) {
    const session = getWorkbenchSession(sessionId);
    if (provider === 'claude' || provider === 'codex') session.provider = provider;
    if (agentId) session.agentId = resolveAgentId(agentId, session.agentId || 'build');
    const clean = String(question || '').trim();
    if (!clean) throw new Error('BTW question is required.');
    const transcript = renderConversationTranscript(session.messages, 26000);
    const answer = await callWorkbenchTextOnlyModel(session, {
        maxTokens: 900,
        system: [
            'You answer a /btw side question for August AI Workbench.',
            'The main agent may still be working. This side answer is ephemeral and must not use tools or mutate state.',
            'Use the provided conversation transcript and answer directly. If the answer is not in context, say what is missing.',
            'Keep the answer concise and useful.'
        ].join('\n'),
        user: [
            'Conversation transcript:',
            transcript || '(no prior Workbench conversation yet)',
            '',
            '/btw side question:',
            clean
        ].join('\n')
    });
    return {
        status: 'ok',
        question: clean,
        answer: answer || '(no response)',
        generatedAt: new Date().toISOString(),
        session: summarizeSession(session)
    };
}

async function evaluateWorkbenchGoal(session) {
    if (!session.goal || session.goal.status !== 'active') return { met: true, reason: 'No active goal.' };
    const transcript = renderConversationTranscript(session.messages, 30000);
    const response = await callWorkbenchTextOnlyModel(session, {
        maxTokens: 300,
        system: [
            'You are the /goal evaluator for August AI Workbench.',
            'Decide whether the active goal is fully met using only the transcript.',
            'Return strict JSON only: {"met": true|false, "reason": "short reason"}.',
            'A goal is met only when the user-visible requested outcome is completed or a real blocker requires user input or approval.'
        ].join('\n'),
        user: [
            'Active goal:',
            session.goal.condition,
            '',
            'Transcript:',
            transcript || '(empty)'
        ].join('\n')
    });
    const parsed = parseJsonObject(response) || {};
    return {
        met: parsed.met === true,
        reason: String(parsed.reason || response || 'Goal evaluator did not provide a reason.').slice(0, 900)
    };
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

async function callWorkbenchModelStream(session, emit) {
    if (session.provider === 'codex') {
        await callOpenAiWorkbenchModelStream(session, emit);
    } else {
        await callAnthropicWorkbenchModelStream(session, emit);
    }
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
        assistant: 'Workbench halted. Review the current plan or send a narrower request.',
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
        assistant: 'Workbench halted. Review the current plan or send a narrower request.',
        content: [],
        events
    };
}

async function sendWorkbenchMessage({ sessionId, message, provider, agentId } = {}) {
    const session = getWorkbenchSession(sessionId);
    if (provider === 'claude' || provider === 'codex') session.provider = provider;
    if (agentId) session.agentId = resolveAgentId(agentId, session.agentId || 'build');
    const text = String(message || '').trim();
    if (!text) throw new Error('Message is required.');
    session.messages.push({ role: 'user', content: text });
    session.updatedAt = new Date().toISOString();
    return callWorkbenchModel(session);
}

function parseWorkbenchSlashCommand(text) {
    const match = String(text || '').trim().match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    return {
        command: match[1].toLowerCase(),
        arg: String(match[2] || '').trim()
    };
}

function appendGoalContinueMessage(session, evaluation) {
    session.messages.push({
        role: 'user',
        content: [
            `/goal is still active: ${session.goal.condition}`,
            `Evaluator: ${evaluation.reason || 'Goal not fully met yet.'}`,
            'Continue autonomously toward the goal. Read/search/inspect as needed, use approved mutations only when allowed, and report concrete progress.'
        ].join('\n')
    });
    session.updatedAt = new Date().toISOString();
}

async function continueGoalUntilReached(session, emit) {
    while (session.goal && session.goal.status === 'active') {
        const evaluation = await evaluateWorkbenchGoal(session);
        const now = new Date().toISOString();
        session.goal.turns = Number(session.goal.turns || 0) + 1;
        session.goal.lastReason = evaluation.reason;
        session.goal.lastMet = evaluation.met === true;
        session.goal.updatedAt = now;

        if (evaluation.met) {
            session.goal.status = 'achieved';
            session.goal.achievedAt = now;
            session.lastGoal = session.goal;
            session.goal = null;
            session.updatedAt = now;
            safeEmit(emit, 'goal', { goal: null, lastGoal: summarizeGoal(session.lastGoal), event: 'achieved' });
            return;
        }

        safeEmit(emit, 'goal', { goal: summarizeGoal(session.goal), lastGoal: summarizeGoal(session.lastGoal), event: 'continue' });
        appendGoalContinueMessage(session, evaluation);
        await callWorkbenchModelStream(session, emit);
    }
}

async function handleGoalCommand(session, arg, emit) {
    const lower = String(arg || '').trim().toLowerCase();
    if (!arg || lower === 'status') {
        const current = summarizeGoal(session.goal);
        const last = summarizeGoal(session.lastGoal);
        safeEmit(emit, 'goal', { goal: current, lastGoal: last, event: current ? 'status' : 'idle' });
        safeEmit(emit, 'text', {
            content: current
                ? `Active goal: ${current.condition}\nStatus: ${current.lastReason || 'running'}`
                : (last ? `No active goal. Last goal (${last.status}): ${last.condition}` : 'No active goal.')
        });
        return;
    }

    if (GOAL_CLEAR_ALIASES.has(lower)) {
        const last = clearWorkbenchGoal(session, 'Goal cleared by the user.');
        safeEmit(emit, 'goal', { goal: null, lastGoal: last, event: 'cleared' });
        safeEmit(emit, 'text', { content: 'Goal cleared.' });
        return;
    }

    const goal = setWorkbenchGoal(session, arg);
    safeEmit(emit, 'goal', { goal, lastGoal: summarizeGoal(session.lastGoal), event: 'started' });
    session.messages.push({
        role: 'user',
        content: [
            `/goal ${goal.condition}`,
            'Work toward this goal and continue until the goal evaluator says it is reached. If user approval or information is required, clearly ask for it.'
        ].join('\n')
    });
    session.updatedAt = new Date().toISOString();
    await callWorkbenchModelStream(session, emit);
    await continueGoalUntilReached(session, emit);
}

function getWorkbenchGoalStatus(sessionId) {
    const session = getWorkbenchSession(sessionId);
    return {
        goal: summarizeGoal(session.goal),
        lastGoal: summarizeGoal(session.lastGoal),
        session: summarizeSession(session)
    };
}

function updateWorkbenchGoal({ sessionId, action, condition } = {}) {
    const session = getWorkbenchSession(sessionId);
    const normalized = String(action || '').toLowerCase();
    if (normalized === 'clear') {
        return { goal: null, lastGoal: clearWorkbenchGoal(session, 'Goal cleared by the user.'), session: summarizeSession(session) };
    }
    if (normalized === 'set') {
        return { goal: setWorkbenchGoal(session, condition), lastGoal: summarizeGoal(session.lastGoal), session: summarizeSession(session) };
    }
    return getWorkbenchGoalStatus(sessionId);
}

/* ── SSE Streaming versions ── */

function safeEmit(emit, type, data) {
    try { emit(type, data); } catch (_) { throw new Error('SSE connection closed'); }
}

async function parseAnthropicStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', eventType = '', eventData = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) eventData = line.slice(6).trim();
            else if (line === '' && eventType && eventData) {
                if (eventData !== '[DONE]') { try { onEvent(eventType, JSON.parse(eventData)); } catch (_) {} }
                eventType = ''; eventData = '';
            }
        }
    }
    if (eventType && eventData && eventData !== '[DONE]') { try { onEvent(eventType, JSON.parse(eventData)); } catch (_) {} }
}

async function parseOpenAiStream(response, onData) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6).trim();
            if (payload === '[DONE]') { onData('[DONE]', null); continue; }
            try { onData('chunk', JSON.parse(payload)); } catch (_) {}
        }
    }
}

async function callAnthropicWorkbenchModelStream(session, emit) {
    const profile = getProfile('claude') || {};
    if (!profile.targetUrl) throw new Error('Claude profile target URL is missing.');
    const model = profile._upstreamModel || profile.currentModel || 'claude-opus-4-6';

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
                tools: toolDefinitions(session),
                stream: true
            }),
            signal: AbortSignal.timeout(300000)
        });
        if (!response.ok) {
            const raw = await response.text();
            throw new Error(`Workbench upstream error ${response.status}: ${raw.slice(0, 500)}`);
        }

        const blocks = {};
        let textBuffer = '';

        await parseAnthropicStream(response, (eventType, data) => {
            switch (eventType) {
                case 'content_block_start': {
                    const block = { ...data.content_block, index: data.index };
                    blocks[data.index] = block;
                    if (block.type === 'tool_use') {
                        safeEmit(emit, 'tool_use', { id: block.id, name: block.name, input: block.input || {} });
                    }
                    break;
                }
                case 'content_block_delta': {
                    const block = blocks[data.index];
                    if (!block) break;
                    if (data.delta.type === 'thinking_delta') {
                        block.thinking = (block.thinking || '') + (data.delta.thinking || '');
                        safeEmit(emit, 'thinking', { content: data.delta.thinking || '' });
                    } else if (data.delta.type === 'text_delta') {
                        block.text = (block.text || '') + (data.delta.text || '');
                        textBuffer += data.delta.text || '';
                    } else if (data.delta.type === 'input_json_delta') {
                        block._inputPart = (block._inputPart || '') + (data.delta.partial_json || '');
                    }
                    break;
                }
                case 'content_block_stop': {
                    const block = blocks[data.index];
                    if (block && block.type === 'tool_use' && block._inputPart) {
                        try { block.input = JSON.parse(block._inputPart); } catch (_) {}
                        delete block._inputPart;
                    }
                    break;
                }
                case 'message_stop': {
                    if (textBuffer) { safeEmit(emit, 'text', { content: textBuffer }); textBuffer = ''; }
                    break;
                }
            }
        });

        if (textBuffer) { safeEmit(emit, 'text', { content: textBuffer }); textBuffer = ''; }

        const content = Object.values(blocks).sort((a, b) => (a.index || 0) - (b.index || 0));
        for (const b of content) { delete b.index; delete b._inputPart; }
        session.messages.push({ role: 'assistant', content });

        const toolUses = content.filter(b => b.type === 'tool_use');
        if (!toolUses.length) {
            session.updatedAt = new Date().toISOString();
            return;
        }

        const toolResults = [];
        for (const toolUse of toolUses) {
            try {
                const result = await executeWorkbenchTool(session, toolUse);
                const c = JSON.stringify(result, null, 2);
                const isError = !!result.blocked;
                safeEmit(emit, 'tool_result', { id: toolUse.id, content: c, is_error: isError });
                toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: c, is_error: isError });
            } catch (e) {
                const c = `[Workbench Tool Error] ${e.message}`;
                safeEmit(emit, 'tool_result', { id: toolUse.id, content: c, is_error: true });
                toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: c, is_error: true });
            }
        }
        session.messages.push({ role: 'user', content: toolResults });
    }

    session.updatedAt = new Date().toISOString();
    safeEmit(emit, 'text', { content: 'Workbench stopped after the maximum tool loop count.' });
}

async function callOpenAiWorkbenchModelStream(session, emit) {
    const profile = getProfile('codex') || {};
    const targetUrl = normalizeOpenAiTargetUrl(profile);
    if (!targetUrl) throw new Error('Codex profile target URL is missing.');
    const model = profile._upstreamModel || profile.currentModel || 'gpt-4o';

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
                stream: true
            }),
            signal: AbortSignal.timeout(300000)
        });
        if (!response.ok) {
            const raw = await response.text();
            throw new Error(`Workbench upstream error ${response.status}: ${raw.slice(0, 500)}`);
        }

        let textBuffer = '';
        const toolCallAccum = {};

        await parseOpenAiStream(response, (eventType, data) => {
            if (eventType === '[DONE]') return;
            const choice = data.choices?.[0];
            if (!choice) return;
            const delta = choice.delta || {};

            if (delta.content) textBuffer += delta.content;

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCallAccum[idx]) toolCallAccum[idx] = {};
                    if (tc.id) toolCallAccum[idx].id = tc.id;
                    if (tc.function?.name) toolCallAccum[idx].name = tc.function.name;
                    if (tc.function?.arguments) {
                        toolCallAccum[idx].args = (toolCallAccum[idx].args || '') + tc.function.arguments;
                    }
                }
            }

            if (choice.finish_reason) {
                const indices = Object.keys(toolCallAccum).sort((a, b) => Number(a) - Number(b));
                for (const i of indices) {
                    const tc = toolCallAccum[i];
                    let input = {};
                    try { input = JSON.parse(tc.args || '{}'); } catch (_) {}
                    safeEmit(emit, 'tool_use', { id: tc.id || newId('toolu'), name: tc.name, input });
                }
                if (textBuffer) { safeEmit(emit, 'text', { content: textBuffer }); textBuffer = ''; }
            }
        });

        const content = [];
        if (textBuffer) content.push({ type: 'text', text: textBuffer });

        const toolUses = [];
        const indices = Object.keys(toolCallAccum).sort((a, b) => Number(a) - Number(b));
        for (const i of indices) {
            const tc = toolCallAccum[i];
            let input = {};
            try { input = JSON.parse(tc.args || '{}'); } catch (_) {}
            const tu = { type: 'tool_use', id: tc.id || newId('toolu'), name: tc.name, input };
            content.push(tu);
            toolUses.push(tu);
        }

        session.messages.push({ role: 'assistant', content });

        if (!toolUses.length) {
            session.updatedAt = new Date().toISOString();
            return;
        }

        const toolResults = [];
        for (const toolUse of toolUses) {
            try {
                const result = await executeWorkbenchTool(session, toolUse);
                const c = JSON.stringify(result, null, 2);
                const isError = !!result.blocked;
                safeEmit(emit, 'tool_result', { id: toolUse.id, content: c, is_error: isError });
                toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: c, is_error: isError });
            } catch (e) {
                const c = `[Workbench Tool Error] ${e.message}`;
                safeEmit(emit, 'tool_result', { id: toolUse.id, content: c, is_error: true });
                toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: c, is_error: true });
            }
        }
        session.messages.push({ role: 'user', content: toolResults });
    }

    session.updatedAt = new Date().toISOString();
    safeEmit(emit, 'text', { content: 'Workbench stopped after the maximum tool loop count.' });
}

async function sendWorkbenchMessageStream({ sessionId, message, provider, agentId } = {}, emit) {
    const session = getWorkbenchSession(sessionId);
    if (provider === 'claude' || provider === 'codex') session.provider = provider;
    if (agentId) session.agentId = resolveAgentId(agentId, session.agentId || 'build');
    const text = String(message || '').trim();
    if (!text) throw new Error('Message is required.');

    const slash = parseWorkbenchSlashCommand(text);
    if (slash?.command === 'goal') {
        await handleGoalCommand(session, slash.arg, emit);
        safeEmit(emit, 'session', summarizeSession(session));
        return;
    }

    if (slash?.command === 'btw') {
        const result = await answerWorkbenchBtw({ sessionId: session.id, question: slash.arg, provider: session.provider, agentId: session.agentId });
        safeEmit(emit, 'btw', result);
        safeEmit(emit, 'text', { content: result.answer });
        safeEmit(emit, 'session', summarizeSession(session));
        return;
    }

    session.messages.push({ role: 'user', content: text });
    session.updatedAt = new Date().toISOString();

    await callWorkbenchModelStream(session, emit);
    await continueGoalUntilReached(session, emit);

    // Background auto-memory extraction
    try {
        const lastAssistant = session.messages.filter(m => m.role === 'assistant').pop();
        if (lastAssistant) {
            const cfg = getProfile(session.provider === 'codex' ? 'codex' : 'claude') || {};
            extractAndSaveMemories(session.messages, lastAssistant, cfg, cfg._upstreamModel || cfg.currentModel, 'workbench')
                .catch(e => console.warn('[Auto-Memory] Workbench extraction failed:', e.message));
        }
    } catch (_) {}

    safeEmit(emit, 'session', summarizeSession(session));
}

function approveWorkbenchPlan(sessionId) {
    const session = getWorkbenchSession(sessionId);
    if (!session.plan) throw new Error('No submitted plan is waiting for approval.');
    session.approved = true;
    session.approvedAt = new Date().toISOString();
    session.updatedAt = session.approvedAt;
    return summarizeSession(session);
}

function resetWorkbenchSession(sessionId, provider, agentId = 'build') {
    if (sessionId) sessions.delete(sessionId);
    return createWorkbenchSession({ provider, agentId });
}

module.exports = {
    WORKSPACE_ROOT,
    answerWorkbenchBtw,
    approveWorkbenchPlan,
    clearWorkbenchGoal,
    createWorkbenchSession,
    executeWorkbenchTool,
    getWorkbenchGoalStatus,
    getWorkbenchSession,
    listAgentRegistry,
    listProxyCapabilities,
    resetWorkbenchSession,
    sendWorkbenchMessage,
    sendWorkbenchMessageStream,
    setWorkbenchGoal,
    summarizeGoal,
    summarizeSession,
    updateWorkbenchGoal
};
