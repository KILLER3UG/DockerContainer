const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

// ── Path Permission System ────────────────────────────────────────────────────
// Any command or file path the AI touches is checked against this list.
// Paths INSIDE → go through normal confirmation gate (ask user).
// Paths OUTSIDE → hard block immediately. AI is told to ask the user first.
//
// Add more entries here if you want to allow additional workspace roots.
const ALLOWED_BASE_PATHS = [
    'C:\\Users\\rober\\LocalFolders',
    'C:/Users/rober/LocalFolders'
];
const NORMALIZED_ALLOWED_BASE_PATHS = ALLOWED_BASE_PATHS.map(base => path.resolve(base));

/**
 * Scans a command string for Windows or Unix absolute paths using regex.
 * Returns an array of all found path strings (may be empty).
 */
function extractPathsFromCommand(command) {
    if (!command || typeof command !== 'string') return [];
    const found = [];

    // Windows absolute paths: C:\... or C:/...
    const winPaths = command.match(/[A-Za-z]:[\\\/][^\s"'`,;|&>]+/g) || [];
    found.push(...winPaths);

    // Unix absolute paths: /home/... /usr/... /etc/... /tmp/... etc.
    // Exclude /v1/ /app/ style API/docker paths which are not real FS paths
    const unixPaths = command.match(/\/(?:home|usr|etc|tmp|var|root|opt|mnt|srv|data)[^\s"'`,;|&>]*/g) || [];
    found.push(...unixPaths);

    return found;
}

function hasParentTraversal(command) {
    return /(^|[\s"'`(])\.\.(?:[\\/]|$)/.test(command);
}

/**
 * Returns null if the path is allowed, or an error message string if blocked.
 * A path is allowed if it starts with one of the ALLOWED_BASE_PATHS.
 */
function checkPathPermission(filePath) {
    const resolvedPath = path.resolve(filePath);
    const isAllowed = NORMALIZED_ALLOWED_BASE_PATHS.some(base => {
        const relative = path.relative(base, resolvedPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (isAllowed) return null;
    return `[August Permission Denied]\n` +
           `The path '${resolvedPath}' is outside the permitted workspace.\n` +
           `Permitted workspace roots:\n${ALLOWED_BASE_PATHS.map(p => `  - ${p}`).join('\n')}\n\n` +
           `You do NOT have permission to access this path. ` +
           `Stop and ask the user to explicitly grant access to this location before proceeding.`;
}

/**
 * Checks all paths found in a command against the allowlist.
 * Returns null if all paths are permitted, or the first block message found.
 */
function checkCommandPaths(command) {
    if (hasParentTraversal(command)) {
        return `[August Permission Denied]\n` +
               `The command contains parent-directory traversal ('..'), which is blocked because it can escape the permitted workspace roots.\n` +
               `Permitted workspace roots:\n${ALLOWED_BASE_PATHS.map(p => `  - ${p}`).join('\n')}\n\n` +
               `Use an explicit path inside the workspace, or ask the user to approve a different location first.`;
    }
    const paths = extractPathsFromCommand(command);
    for (const p of paths) {
        const blockMsg = checkPathPermission(p);
        if (blockMsg) return blockMsg;
    }
    return null; // all clear
}

const CORE_MEMORY_FILE = path.join(__dirname, '..', 'august_core_memory.json');

function getDefaultAugustCoreMemory() {
    return {
        user_profile: "No profile details recorded yet. Use august__core_memory_append to add details about the user.",
        global_context: "No cross-session context established.",
        active_projects: [],
        integrations: {},
        recent_events: [],
        conversation_checkpoints: []
    };
}

function normalizeAugustCoreMemory(raw) {
    const defaults = getDefaultAugustCoreMemory();
    const merged = {
        ...defaults,
        ...(raw && typeof raw === 'object' ? raw : {})
    };

    if (typeof merged.user_profile !== 'string') merged.user_profile = defaults.user_profile;
    if (typeof merged.global_context !== 'string') merged.global_context = defaults.global_context;
    if (!Array.isArray(merged.active_projects)) merged.active_projects = [];
    if (!merged.integrations || typeof merged.integrations !== 'object' || Array.isArray(merged.integrations)) merged.integrations = {};
    if (!Array.isArray(merged.recent_events)) merged.recent_events = [];
    if (!Array.isArray(merged.conversation_checkpoints)) merged.conversation_checkpoints = [];

    merged.active_projects = merged.active_projects
        .filter(p => p && typeof p === 'object' && p.name)
        .slice(-20);
    merged.recent_events = merged.recent_events
        .filter(e => e && typeof e === 'object' && e.summary)
        .slice(-40);
    merged.conversation_checkpoints = merged.conversation_checkpoints
        .filter(c => c && typeof c === 'object' && c.summary)
        .slice(-20);

    return merged;
}

function readAugustCoreMemory() {
    if (!fs.existsSync(CORE_MEMORY_FILE)) {
        const defaultMemory = getDefaultAugustCoreMemory();
        fs.writeFileSync(CORE_MEMORY_FILE, JSON.stringify(defaultMemory, null, 2));
        return defaultMemory;
    }
    try {
        return normalizeAugustCoreMemory(JSON.parse(fs.readFileSync(CORE_MEMORY_FILE, 'utf8')));
    } catch (e) {
        return normalizeAugustCoreMemory({ error: "Failed to parse core memory." });
    }
}

function writeAugustCoreMemory(data) {
    fs.writeFileSync(CORE_MEMORY_FILE, JSON.stringify(normalizeAugustCoreMemory(data), null, 2));
}

function renderAugustCoreMemory(memoryInput) {
    const memory = normalizeAugustCoreMemory(memoryInput);
    const projects = memory.active_projects.length > 0
        ? memory.active_projects.map(p => {
            const status = p.status ? ` (${p.status})` : '';
            const summary = p.summary ? `: ${p.summary}` : '';
            return `- ${p.name}${status}${summary}`;
        }).join('\n')
        : '- none recorded';
    const integrations = Object.keys(memory.integrations).length > 0
        ? Object.entries(memory.integrations).map(([name, details]) => {
            if (!details || typeof details !== 'object') return `- ${name}`;
            const status = details.status ? ` (${details.status})` : '';
            const summary = details.summary ? `: ${details.summary}` : '';
            return `- ${name}${status}${summary}`;
        }).join('\n')
        : '- none recorded';
    const recentEvents = memory.recent_events.length > 0
        ? memory.recent_events.slice(-8).map(event => {
            const when = event.timestamp ? `[${event.timestamp}] ` : '';
            return `- ${when}${event.summary}`;
        }).join('\n')
        : '- none recorded';
    const checkpoints = memory.conversation_checkpoints.length > 0
        ? memory.conversation_checkpoints.slice(-6).map(cp => {
            const topic = cp.topic ? `${cp.topic}: ` : '';
            return `- ${topic}${cp.summary}`;
        }).join('\n')
        : '- none recorded';

    return {
        user_profile: memory.user_profile,
        global_context: memory.global_context,
        active_projects: projects,
        integrations,
        recent_events: recentEvents,
        conversation_checkpoints: checkpoints
    };
}

function upsertProject(memory, project) {
    const normalized = normalizeAugustCoreMemory(memory);
    const nextProject = {
        name: project.name,
        status: project.status || '',
        summary: project.summary || '',
        updated_at: new Date().toISOString()
    };
    const existingIndex = normalized.active_projects.findIndex(p => p.name === project.name);
    if (existingIndex >= 0) normalized.active_projects[existingIndex] = { ...normalized.active_projects[existingIndex], ...nextProject };
    else normalized.active_projects.push(nextProject);
    normalized.active_projects = normalized.active_projects.slice(-20);
    return normalized;
}

function upsertIntegration(memory, integration) {
    const normalized = normalizeAugustCoreMemory(memory);
    normalized.integrations[integration.name] = {
        status: integration.status || '',
        summary: integration.summary || '',
        updated_at: new Date().toISOString()
    };
    return normalized;
}

function appendRecentEvent(memory, event) {
    const normalized = normalizeAugustCoreMemory(memory);
    normalized.recent_events.push({
        summary: event.summary,
        timestamp: event.timestamp || new Date().toISOString(),
        source: event.source || ''
    });
    normalized.recent_events = normalized.recent_events.slice(-40);
    return normalized;
}

function appendCheckpoint(memory, checkpoint) {
    const normalized = normalizeAugustCoreMemory(memory);
    normalized.conversation_checkpoints.push({
        topic: checkpoint.topic || '',
        summary: checkpoint.summary,
        timestamp: checkpoint.timestamp || new Date().toISOString()
    });
    normalized.conversation_checkpoints = normalized.conversation_checkpoints.slice(-20);
    return normalized;
}

const AUGUST_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'august__bash',
            description: 'Executes a PowerShell command on the host machine. You MUST show the user the exact command and ask for confirmation before calling this tool with confirmed=true. Always call once without confirmed to show the command, then call again with confirmed=true after approval.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The exact PowerShell command to execute.'
                    },
                    confirmed: {
                        type: 'boolean',
                        description: 'Must be true to actually run the command. Set to false (or omit) on the first call to preview; the proxy will prompt the user for approval.'
                    }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember_project',
            description: 'Upserts an active project in August\'s shared brain so the same project context carries across devices and sessions.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Project name.' },
                    status: { type: 'string', description: 'Current project status.' },
                    summary: { type: 'string', description: 'Short description of the project and current focus.' }
                },
                required: ['name', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember_integration',
            description: 'Upserts an integration state in August\'s shared brain, such as Claude Desktop, browser tools, phone access, or APIs.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Integration name.' },
                    status: { type: 'string', description: 'Current status of the integration.' },
                    summary: { type: 'string', description: 'Important notes about how the integration behaves.' }
                },
                required: ['name', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__search_past_conversations',
            description: 'Searches the infinite memory vector database for past conversations. Use this when the user asks about something you discussed weeks or months ago that is no longer in your immediate memory. The search uses semantic similarity, so search queries should be full sentences or detailed phrases.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The semantic query to search for.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember_event',
            description: 'Adds an important recent event to August\'s shared brain so future sessions remember what happened.',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string', description: 'What happened and why it matters.' },
                    source: { type: 'string', description: 'Where this event came from, such as claude-desktop or proxy.' },
                    timestamp: { type: 'string', description: 'Optional ISO timestamp; defaults to now.' }
                },
                required: ['summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember_checkpoint',
            description: 'Stores a durable conversation checkpoint so the same assistant identity can resume later across devices.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'Short topic or conversation area.' },
                    summary: { type: 'string', description: 'What should be remembered for resuming later.' },
                    timestamp: { type: 'string', description: 'Optional ISO timestamp; defaults to now.' }
                },
                required: ['summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__read_file',
            description: 'Reads the contents of a file on the host machine.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute or relative path to the file.'
                    }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__write_file',
            description: 'Creates or overwrites a file on the host machine. You MUST show the user the target path and ask for confirmation before calling this tool with confirmed=true. Always call once without confirmed to preview; the proxy will prompt the user for approval.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute or relative path to the file.'
                    },
                    content: {
                        type: 'string',
                        description: 'The exact text content to write to the file.'
                    },
                    confirmed: {
                        type: 'boolean',
                        description: 'Must be true to actually write the file. Set to false (or omit) on the first call to preview the target path; the proxy will ask the user to confirm.'
                    }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__core_memory_append',
            description: 'Adds a new fact to August\'s Global Brain. Use this to remember user preferences, names, or important project rules across all devices and sessions.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        enum: ['user_profile', 'global_context'],
                        description: 'Which section of the brain to append to.'
                    },
                    content: {
                        type: 'string',
                        description: 'The new fact to append.'
                    }
                },
                required: ['section', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__core_memory_replace',
            description: 'Completely rewrites a section of August\'s Global Brain. Use this if the context is getting too long or needs a full update.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        enum: ['user_profile', 'global_context'],
                        description: 'Which section of the brain to replace.'
                    },
                    content: {
                        type: 'string',
                        description: 'The complete new text for this section.'
                    }
                },
                required: ['section', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__spawn_background_task',
            description: 'Spawns a detached PowerShell script that will run in the background indefinitely. Use this for massive scraping jobs, long compiles, or starting watcher servers. The output is streamed to august_background.log',
            parameters: {
                type: 'object',
                properties: {
                    script_content: {
                        type: 'string',
                        description: 'The exact PowerShell script content to execute in the background.'
                    }
                },
                required: ['script_content']
            }
        }
    }
];

function isAugustToolName(name) {
    return typeof name === 'string' && name.startsWith('august__');
}

function getAugustToolDefinitions() {
    return AUGUST_TOOLS;
}

async function executeAugustToolCall(toolName, args) {
    try {
        switch (toolName) {
            case 'august__bash': {
                // ── Permission check ──
                const pathViolation = checkCommandPaths(args.command);
                if (pathViolation) return pathViolation;

                // ── Confirmation gate ──
                // The AI must first call with confirmed=false (or omitted) to surface
                // the command to the user. Only executes when confirmed=true.
                if (!args.confirmed) {
                    return `[August Confirmation Required]\n` +
                           `The AI wants to run the following PowerShell command on your machine:\n\n` +
                           `  ${args.command}\n\n` +
                           `To approve, call this tool again with the same command and confirmed=true.\n` +
                           `To cancel, tell me to stop.`;
                }
                // Executing in PowerShell explicitly
                const { stdout, stderr } = await execPromise(args.command, { shell: 'powershell.exe' });
                if (stderr && stderr.trim().length > 0) {
                    return `[Executed with Warnings/Errors]\n${stderr}\n[Output]\n${stdout}`;
                }
                return stdout || '[Command executed successfully with no output]';
            }

            case 'august__read_file': {
                const readPath = path.resolve(args.path);

                // ── Permission check ──
                const pathViolation = checkPathPermission(readPath);
                if (pathViolation) return pathViolation;

                if (!fs.existsSync(readPath)) {
                    throw new Error(`File not found: ${readPath}`);
                }
                return fs.readFileSync(readPath, 'utf8');
            }

            case 'august__write_file': {
                const writePath = path.resolve(args.path);

                // ── Permission check ──
                const pathViolation = checkPathPermission(writePath);
                if (pathViolation) return pathViolation;

                // ── Confirmation gate ──
                if (!args.confirmed) {
                    return `[August Confirmation Required]\n` +
                           `The AI wants to write a file to the following path:\n\n` +
                           `  ${writePath}\n\n` +
                           `Content preview (first 300 chars):\n${String(args.content).slice(0, 300)}${args.content.length > 300 ? '\n...(truncated)' : ''}\n\n` +
                           `To approve, call this tool again with the same arguments and confirmed=true.\n` +
                           `To write to a different path, specify a new path and confirmed=true.\n` +
                           `To cancel, tell me to stop.`;
                }
                const dir = path.dirname(writePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(writePath, args.content, 'utf8');
                return `Successfully wrote to ${writePath}`;
            }

            case 'august__core_memory_append':
                const appendMem = readAugustCoreMemory();
                if (!appendMem[args.section]) appendMem[args.section] = "";
                appendMem[args.section] += `\n- ${args.content}`;
                writeAugustCoreMemory(appendMem);
                return `Successfully appended to ${args.section} memory.`;

            case 'august__core_memory_replace':
                const replaceMem = readAugustCoreMemory();
                replaceMem[args.section] = args.content;
                writeAugustCoreMemory(replaceMem);
                return `Successfully replaced ${args.section} memory.`;

            case 'august__remember_project': {
                const nextMemory = upsertProject(readAugustCoreMemory(), args);
                writeAugustCoreMemory(nextMemory);
                return `Successfully updated project memory for ${args.name}.`;
            }

            case 'august__remember_integration': {
                const nextMemory = upsertIntegration(readAugustCoreMemory(), args);
                writeAugustCoreMemory(nextMemory);
                return `Successfully updated integration memory for ${args.name}.`;
            }

            case 'august__remember_event': {
                const nextMemory = appendRecentEvent(readAugustCoreMemory(), args);
                writeAugustCoreMemory(nextMemory);
                return `Successfully recorded recent event.`;
            }

            case 'august__remember_checkpoint': {
                const nextMemory = appendCheckpoint(readAugustCoreMemory(), args);
                writeAugustCoreMemory(nextMemory);
                return `Successfully recorded recent conversation checkpoint.`;
            }

            case 'august__search_past_conversations': {
                const { getProfile } = require('./config');
                const cfg = getProfile('claude'); // Fallback to claude profile for embeddings
                
                let embeddingsUrl = cfg.targetUrl;
                if (embeddingsUrl.includes('/anthropic')) {
                    embeddingsUrl = embeddingsUrl.replace('/anthropic/v1/messages', '/v1/embeddings').replace('/anthropic', '/v1/embeddings');
                } else if (embeddingsUrl.includes('/v1/')) {
                    embeddingsUrl = embeddingsUrl.substring(0, embeddingsUrl.indexOf('/v1/') + 4) + 'embeddings';
                } else {
                    return `Error: Could not determine embeddings API endpoint from proxy configuration.`;
                }

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
                        input: args.query
                    }),
                    signal: AbortSignal.timeout(10000)
                });

                if (!embedResponse.ok) {
                    return `Error: Failed to generate query embedding. Upstream returned ${embedResponse.status}.`;
                }

                const embedData = await embedResponse.json();
                const vector = embedData.data?.[0]?.embedding;
                
                if (!vector || !Array.isArray(vector)) {
                    return `Error: Invalid embedding returned from upstream.`;
                }

                const { searchCheckpoints } = require('./vector-db');
                const results = searchCheckpoints(vector, 3);
                
                if (results.length === 0) {
                    return `No past conversations found matching the query.`;
                }

                return `[Infinite Memory Database Results]\n\n` + results.map(r => 
                    `Date: ${r.timestamp}\nTopic: ${r.topic}\nSummary: ${r.summary}\nRelevance: ${(r.score * 100).toFixed(1)}%`
                ).join('\n\n---\n\n');
            }

            case 'august__spawn_background_task': {
                // ── Permission check ──
                const pathViolation = checkCommandPaths(args.script_content);
                if (pathViolation) return pathViolation;

                const scriptName = path.join(__dirname, '..', `august_bg_task_${Date.now()}.ps1`);
                fs.writeFileSync(scriptName, args.script_content, 'utf8');
                const outLog = path.join(__dirname, '..', 'august_background.log');
                
                // Spawn detached powershell process
                const { spawn } = require('child_process');
                const child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptName], {
                    detached: true,
                    stdio: ['ignore', fs.openSync(outLog, 'a'), fs.openSync(outLog, 'a')]
                });
                
                child.unref(); // Allow the main proxy to exit without waiting for this child

                // Clean up the temp script file after a short delay.
                // We wait 2 seconds so PowerShell has time to open and read the file
                // before we delete it. The process itself continues running from its
                // in-memory copy once loaded.
                setTimeout(() => {
                    try {
                        if (fs.existsSync(scriptName)) fs.unlinkSync(scriptName);
                    } catch (e) {
                        console.warn(`[August] Failed to delete temp script ${scriptName}:`, e.message);
                    }
                }, 2000);
                
                return `Background task successfully spawned (PID: ${child.pid}). The script is now running independently and its output is streaming into august_background.log. The temporary script file will be auto-deleted in 2 seconds. You can continue interacting with the user immediately.`;
            }

            default:
                throw new Error(`Unknown august tool: ${toolName}`);
        }
    } catch (error) {
        return `[Tool Execution Failed]: ${error.message}`;
    }
}

module.exports = {
    getAugustToolDefinitions,
    isAugustToolName,
    executeAugustToolCall,
    readAugustCoreMemory,
    writeAugustCoreMemory,
    renderAugustCoreMemory
};
