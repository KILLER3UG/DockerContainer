const assert = require('assert');
const { enhanceToolResult } = require('../src/utils/selfheal');

const browserUseImport = [
    'Resolved: https://github.com/browser-use/browser-use.git',
    'Plugins: uvx-browser-use-install-Run-if-you-don-t-have-Chromium-installed',
    'Skills: uvx-browser-use-install-Run-if-you-don-t-have-Chromium-installed',
    'MCP servers: none'
].join('\n');

const enhanced = enhanceToolResult(browserUseImport);
assert(enhanced.includes('[Proxy Self-Heal]: Browser Use imported without an MCP server'), 'browser-use no-MCP import should get a repair hint');
assert(enhanced.includes('uvx --from browser-use[cli] browser-use --mcp'), 'browser-use MCP command should be suggested');
assert(enhanced.includes('uvx --from browser-use[cli] browser-use install'), 'Chromium install command should be suggested');

const ok = 'All good.';
assert.strictEqual(enhanceToolResult(ok), ok, 'non-error content should not be modified');

console.log('SUCCESS selfheal');
