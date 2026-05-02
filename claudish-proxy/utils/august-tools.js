const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

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
            description: 'Executes a PowerShell command on the host machine. Use this to run scripts, start servers, or manage the local environment.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The exact PowerShell command to execute.'
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
            description: 'Creates or overwrites a file on the host machine.',
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
            case 'august__bash':
                // Executing in PowerShell explicitly
                const { stdout, stderr } = await execPromise(args.command, { shell: 'powershell.exe' });
                if (stderr && stderr.trim().length > 0) {
                    return `[Executed with Warnings/Errors]\n${stderr}\n[Output]\n${stdout}`;
                }
                return stdout || '[Command executed successfully with no output]';

            case 'august__read_file':
                const readPath = path.resolve(args.path);
                if (!fs.existsSync(readPath)) {
                    throw new Error(`File not found: ${readPath}`);
                }
                return fs.readFileSync(readPath, 'utf8');

            case 'august__write_file':
                const writePath = path.resolve(args.path);
                const dir = path.dirname(writePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(writePath, args.content, 'utf8');
                return `Successfully wrote to ${writePath}`;

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

            case 'august__spawn_background_task':
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
                
                return `Background task successfully spawned (PID: ${child.pid}). The script was saved to ${scriptName} and its output is actively streaming into august_background.log. You can continue interacting with the user immediately.`;

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
