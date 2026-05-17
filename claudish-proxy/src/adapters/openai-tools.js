const { logActivity } = require('../../src/utils/logger');
const { getMcpToolDefinitions, isMcpToolName, executeMcpToolCall } = require('../../src/utils/mcp-client');
const { getAugustToolDefinitions, isAugustToolName, executeAugustToolCall } = require('../../src/utils/august-tools');
const { getCoworkToolDefinitions, isCoworkToolName, executeCoworkToolCall } = require('../../src/utils/cowork-tools');
const { executeManagedWebTool } = require('../../src/utils/local-web');
const { validateToolArguments } = require('../../src/utils/validator');

const MANAGED_WEB_TOOL_NAMES = new Set([
    'WebSearch', 'WebFetch', 'web_search', 'web_fetch',
    'mcp__workspace__web_search', 'mcp__workspace__web_fetch'
]);

function isManagedWebToolName(name) {
    return typeof name === 'string' && MANAGED_WEB_TOOL_NAMES.has(name);
}

function isProxyManagedLocalToolName(name) {
    return (
        isManagedWebToolName(name) ||
        isCoworkToolName(name) ||
        isAugustToolName(name) ||
        isMcpToolName(name)
    );
}

function getToolDefinitionName(tool) {
    return tool?.function?.name || tool?.name || '';
}

function appendMissingOpenAiTools(targetTools, extraTools) {
    const seen = new Set((targetTools || []).map(getToolDefinitionName).filter(Boolean));
    const appended = [];
    for (const tool of extraTools || []) {
        const name = getToolDefinitionName(tool);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        targetTools.push(tool);
        appended.push(name);
    }
    return appended;
}

function getProxyOpenAiToolDefinitions() {
    return [
        ...getMcpToolDefinitions(),
        ...getCoworkToolDefinitions(),
        ...getAugustToolDefinitions(),
        ...getCanonicalManagedOpenAiWebTools()
    ];
}

function getCanonicalManagedOpenAiWebTools() {
    return [
        {
            type: 'function',
            function: {
                name: 'WebSearch',
                description: 'Search the public web for relevant pages. Use only for external/public information.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'The web search query.' },
                        prompt: { type: 'string', description: 'Compatibility alias for query.' },
                        max_results: { type: 'integer', description: 'Maximum number of results.' }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'WebFetch',
                description: 'Fetch and summarize a public webpage by URL. Private/local network addresses are blocked.',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'The public HTTP or HTTPS URL to fetch.' },
                        prompt: { type: 'string', description: 'Compatibility alias for url.' }
                    },
                    required: ['url']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__workspace__web_search',
                description: 'Search the public web for relevant pages. Workspace-compatible alias.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'The web search query.' },
                        prompt: { type: 'string', description: 'Compatibility alias for query.' },
                        max_results: { type: 'integer', description: 'Maximum number of results.' }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__workspace__web_fetch',
                description: 'Fetch and summarize a public webpage by URL. Workspace-compatible alias.',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'The public HTTP or HTTPS URL to fetch.' },
                        prompt: { type: 'string', description: 'Compatibility alias for url.' }
                    },
                    required: ['url']
                }
            }
        }
    ];
}

function formatManagedToolResult(toolName, result) {
    if (isManagedWebToolName(toolName)) {
        if (!result || typeof result !== 'object') return String(result || '');
        if (Array.isArray(result.results)) {
            const lines = [`Search query: ${result.query || ''}`, `Result count: ${result.count ?? result.results.length}`];
            result.results.forEach((item, idx) => {
                lines.push(`[${idx + 1}] ${item.title || 'Untitled'}`);
                if (item.url) lines.push(`URL: ${item.url}`);
                if (item.snippet) lines.push(`Snippet: ${item.snippet}`);
            });
            return lines.join('\n');
        }
        if (result.url || result.content) {
            return [
                `Title: ${result.title || ''}`.trim(),
                `URL: ${result.url || ''}`.trim(),
                result.status ? `Status: ${result.status}` : '',
                '',
                result.content || ''
            ].filter(Boolean).join('\n');
        }
        return JSON.stringify(result);
    }
    if (typeof result === 'string') return result;
    if (result === undefined || result === null) return '';
    return JSON.stringify(result);
}

async function executeManagedProxyTool(toolName, args) {
    if (isManagedWebToolName(toolName)) {
        const localName = (toolName === 'WebSearch' || toolName === 'web_search' || toolName === 'mcp__workspace__web_search') ? 'web_search' : 'web_fetch';
        logActivity('WEB', `${toolName} executed locally`);
        return executeManagedWebTool(localName, args || {});
    }
    if (isCoworkToolName(toolName)) {
        logActivity('COWORK', `${toolName} executed by proxy compatibility layer`);
        return executeCoworkToolCall(toolName, args || {});
    }
    if (isAugustToolName(toolName)) {
        logActivity('AUGUST', `${toolName} executed locally`);
        return executeAugustToolCall(toolName, args);
    }
    if (isMcpToolName(toolName)) {
        return executeMcpToolCall(toolName, args);
    }
    throw new Error(`Unsupported managed proxy tool: ${toolName}`);
}

async function executeManagedOpenAiToolCalls(toolCalls, knownTools, messages) {
    const results = [];
    for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        if (!toolName) continue;
        const syntheticCall = { function: { name: toolName, arguments: tc.function?.arguments || '{}' } };
        const validation = validateToolArguments(syntheticCall, knownTools, messages);
        if (!validation.valid) {
            console.warn(`[Proxy Validator]: OpenAI tool '${toolName}' rejected:`, validation.error);
            results.push({
                tool_call_id: tc.id,
                role: 'tool',
                content: `[Validation Error] Tool '${toolName}' rejected before execution:\n${validation.error}\n\n[Proxy Self-Heal]: Fix the tool arguments and retry. Do NOT stop.`
            });
            continue;
        }

        let parsedArgs;
        try {
            parsedArgs = JSON.parse(tc.function?.arguments || '{}');
        } catch {
            parsedArgs = {};
        }

        try {
            const result = await executeManagedProxyTool(toolName, parsedArgs);
            results.push({
                tool_call_id: tc.id,
                role: 'tool',
                content: formatManagedToolResult(toolName, result)
            });
        } catch (e) {
            results.push({
                tool_call_id: tc.id,
                role: 'tool',
                content: `Error: ${e.message}`
            });
        }
    }
    return results;
}

module.exports = {
    MANAGED_WEB_TOOL_NAMES,
    isManagedWebToolName,
    isProxyManagedLocalToolName,
    getToolDefinitionName,
    appendMissingOpenAiTools,
    getProxyOpenAiToolDefinitions,
    getCanonicalManagedOpenAiWebTools,
    formatManagedToolResult,
    executeManagedProxyTool,
    executeManagedOpenAiToolCalls
};
