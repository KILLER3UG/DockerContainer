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


function readAugustCoreMemory() {
    if (!fs.existsSync(CORE_MEMORY_FILE)) {
        const defaultMemory = {
            "user_profile": "No profile details recorded yet. Use august__core_memory_append to add details about the user.",
            "global_context": "No cross-session context established."
        };
        fs.writeFileSync(CORE_MEMORY_FILE, JSON.stringify(defaultMemory, null, 2));
        return defaultMemory;
    }
    try {
        return JSON.parse(fs.readFileSync(CORE_MEMORY_FILE, 'utf8'));
    } catch (e) {
        return { error: "Failed to parse core memory." };
    }
}

function writeAugustCoreMemory(data) {
    fs.writeFileSync(CORE_MEMORY_FILE, JSON.stringify(data, null, 2));
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
    readAugustCoreMemory
};
