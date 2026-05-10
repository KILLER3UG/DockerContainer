const assert = require('assert');
const {
    getBuiltinMcpServers,
    mergeMcpServers,
    normalizeMcpServer,
    toEnvObject,
    toStringArray
} = require('../src/utils/mcp-registry');

assert.deepStrictEqual(toStringArray('-y\n@scope/server\n/app/host_files'), ['-y', '@scope/server', '/app/host_files']);
assert.deepStrictEqual(toStringArray('["-y","pkg"]'), ['-y', 'pkg']);
assert.deepStrictEqual(toEnvObject('TOKEN=${env:TOKEN}\nMODE=debug'), {
    TOKEN: '${env:TOKEN}',
    MODE: 'debug'
});

const normalized = normalizeMcpServer({
    name: 'custom_tools',
    enabled: false,
    command: 'npx',
    args: '-y\ncustom-mcp',
    env: '{"API_KEY":"${env:CUSTOM_API_KEY}"}',
    cwd: '/app',
    timeoutMs: 500
});

assert.strictEqual(normalized.enabled, false);
assert.strictEqual(normalized.timeoutMs, 1000);
assert.deepStrictEqual(normalized.args, ['-y', 'custom-mcp']);
assert.strictEqual(normalized.env.API_KEY, '${env:CUSTOM_API_KEY}');

const builtins = getBuiltinMcpServers();
const fetchServer = builtins.find(server => server.name === 'fetch');
const minimaxServer = builtins.find(server => server.name === 'minimax');
assert(fetchServer, 'fetch MCP server should be built in');
assert.strictEqual(fetchServer.command, 'uvx');
assert.deepStrictEqual(fetchServer.args, ['mcp-server-fetch']);
assert.strictEqual(minimaxServer.env.MINIMAX_API_KEY, '${env:MINIMAX_API_KEY}');

const merged = mergeMcpServers([
    { name: 'filesystem', enabled: false, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    { name: 'extra', command: 'node', args: ['server.js'] }
]);

assert.strictEqual(merged.find(server => server.name === 'filesystem').enabled, false);
assert(merged.find(server => server.name === 'extra'), 'custom MCP server should be merged');

console.log('SUCCESS mcp-registry');
