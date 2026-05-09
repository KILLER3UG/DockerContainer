let Client = null;
let StdioClientTransport = null;
let mcpSdkLoadError = null;

try {
    ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
    ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
} catch (error) {
    mcpSdkLoadError = error;
    console.warn(`[MCP] SDK unavailable; MCP servers disabled: ${error.message}`);
}
const { mcpServers } = require('./mcp-config.js');

const clients = new Map();
const toolRegistry = new Map(); // "mcp__serverName__toolName" -> tool schema

async function startServer(config) {
    if (!Client || !StdioClientTransport) {
        return;
    }
    console.log(`[MCP] Starting server '${config.name}'...`);
    
    // Pass existing env vars plus any server-specific ones
    const env = { ...process.env, ...config.env };
    
    // For npx on Windows, we usually need 'npx.cmd'
    const command = process.platform === 'win32' && config.command === 'npx' ? 'npx.cmd' : config.command;
    const isUvx = config.command === 'uvx';
    const finalCommand = process.platform === 'win32' && isUvx ? 'uvx.exe' : command;

    const transport = new StdioClientTransport({
        command: finalCommand,
        args: config.args,
        env
    });

    const client = new Client({
        name: `claudish-proxy-${config.name}`,
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    try {
        await client.connect(transport);
        clients.set(config.name, { client, transport });
        console.log(`[MCP] Connected to '${config.name}'.`);
        
        // Fetch and register tools
        const response = await client.listTools();
        const tools = response.tools || [];
        console.log(`[MCP] '${config.name}' provides ${tools.length} tools.`);
        
        tools.forEach(tool => {
            const namespacedName = `mcp__${config.name}__${tool.name}`;
            const toolDefinition = {
                type: 'function',
                function: {
                    name: namespacedName,
                    description: `[MCP: ${config.name}] ${tool.description || ''}`,
                    parameters: tool.inputSchema
                }
            };
            toolRegistry.set(namespacedName, toolDefinition);
        });

    } catch (e) {
        console.error(`[MCP] Failed to start '${config.name}':`, e.message);
    }
}

async function startMcpServers(minimaxApiKey) {
    if (!Client || !StdioClientTransport) {
        return;
    }
    if (minimaxApiKey && !process.env.MINIMAX_API_KEY) {
        process.env.MINIMAX_API_KEY = minimaxApiKey;
    }
    
    for (const config of mcpServers) {
        await startServer(config);
    }
}

function getMcpToolDefinitions() {
    return Array.from(toolRegistry.values());
}

function isMcpToolName(name) {
    return name && name.startsWith('mcp__');
}

async function executeMcpToolCall(toolName, args) {
    if (!Client || !StdioClientTransport) {
        throw new Error(`[MCP Disabled] ${mcpSdkLoadError?.message || 'MCP SDK not installed.'}`);
    }
    if (!isMcpToolName(toolName)) {
        throw new Error(`Not an MCP tool: ${toolName}`);
    }

    const parts = toolName.split('__');
    if (parts.length < 3) throw new Error(`Invalid MCP tool name format: ${toolName}`);
    
    const serverName = parts[1];
    const originalToolName = parts.slice(2).join('__'); // in case tool name has '__' in it

    const server = clients.get(serverName);
    if (!server) {
        throw new Error(`MCP server '${serverName}' is not running.`);
    }

    console.log(`[MCP] Executing '${originalToolName}' on '${serverName}'...`);
    try {
        const result = await server.client.callTool({
            name: originalToolName,
            arguments: args
        });

        // Format result back to string — guard against non-text blocks and missing content
        const content = result?.content || [];
        const text = content
            .map(c => c.text ?? (c.type ? `[${c.type} block]` : JSON.stringify(c)))
            .filter(Boolean)
            .join('\n') || '(empty response)';

        if (result.isError) {
            return `[MCP Error] ${text}`;
        }
        return text;
    } catch (e) {
        throw new Error(`[MCP Execution Error] ${e.message}`);
    }
}

module.exports = {
    startMcpServers,
    getMcpToolDefinitions,
    isMcpToolName,
    executeMcpToolCall
};
