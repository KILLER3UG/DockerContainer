const assert = require('assert');
const {
    normalizePlugin,
    renderPluginsForSystem
} = require('../src/utils/plugins');

const plugin = normalizePlugin({
    name: '@GitHub Helper',
    description: 'Adds repository workflow behavior.',
    sourceUrl: 'https://github.com/example/plugin',
    skills: [{ name: 'repo_helper', description: 'Repository workflow skill.' }],
    mcpServers: [{ name: 'repo_mcp', command: 'npx', args: ['-y', 'repo-mcp'] }]
});

assert.strictEqual(plugin.name, 'GitHub-Helper', 'plugin name should normalize');
assert.strictEqual(plugin.enabled, true, 'plugin should default enabled');

const rendered = renderPluginsForSystem([plugin]);
assert(rendered.includes('<plugin name="GitHub-Helper">'), 'plugin XML wrapper missing');
assert(rendered.includes('Adds repository workflow behavior.'), 'plugin description missing');
assert(rendered.includes('<mcp_servers>'), 'MCP plugin section missing');
assert(rendered.includes('<skills>'), 'skill plugin section missing');

console.log('SUCCESS plugins');
