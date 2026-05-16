const assert = require('assert');
const {
    analyzeCapabilityText,
    buildCandidateUrls,
    getBrowserUseRecipe
} = require('../src/utils/link-importer');

const candidates = buildCandidateUrls('https://github.com/example/cool-mcp/tree/dev');
assert(candidates.includes('https://raw.githubusercontent.com/example/cool-mcp/dev/.mcp.json'), 'tree branch candidate missing');
assert(candidates.includes('https://raw.githubusercontent.com/example/cool-mcp/main/plugin.json'), 'main plugin candidate missing');
assert(candidates.includes('https://raw.githubusercontent.com/example/cool-mcp/master/SKILL.md'), 'master skill candidate missing');

const analyzed = analyzeCapabilityText(JSON.stringify({
    name: 'cool tools',
    description: 'Imported local proxy plugin',
    mcpServers: {
        cowork_extra: {
            command: 'npx',
            args: ['-y', '@example/cowork-extra'],
            env: { TOKEN: 'demo' }
        },
        shell_string: 'uvx'
    },
    skill: {
        name: 'repo_helper',
        description: 'Helps with repo work',
        trigger: 'When a repository link is pasted.',
        instructions: 'Inspect repository metadata before suggesting commands.'
    }
}), 'https://example.com/plugin.json', { enableMcp: false });

assert.strictEqual(analyzed.mcpServers.length, 2, 'MCP server object map should parse');
assert.strictEqual(analyzed.mcpServers[0].enabled, false, 'MCP import should default disabled');
assert.strictEqual(analyzed.skills.length, 1, 'single skill object should parse');
assert.strictEqual(analyzed.plugins.length, 1, 'plugin wrapper should be created');
assert.strictEqual(analyzed.plugins[0].name, 'cool-tools', 'plugin name should be normalized');

const markdown = analyzeCapabilityText([
    '---',
    'name: github_skill',
    'description: Imported GitHub workflow skill',
    '---',
    '# GitHub Skill',
    'Use this skill when the user asks for repository workflow help.'
].join('\n'), 'https://raw.githubusercontent.com/example/repo/main/SKILL.md');

assert.strictEqual(markdown.skills[0].name, 'github_skill', 'frontmatter skill name should parse');
assert(markdown.skills[0].instructions.includes('repository workflow'), 'skill markdown instructions missing');

const browserUseRecipe = getBrowserUseRecipe('https://github.com/browser-use/browser-use.git', { enableMcp: true });
assert(browserUseRecipe, 'browser-use GitHub URL should use the known MCP recipe');
assert.strictEqual(browserUseRecipe.mcpServers.length, 1, 'browser-use recipe should include an MCP server');
assert.strictEqual(browserUseRecipe.mcpServers[0].name, 'browser-use', 'browser-use server name should be stable');
assert.deepStrictEqual(
    browserUseRecipe.mcpServers[0].args,
    ['--from', 'browser-use[cli]', 'browser-use', '--mcp'],
    'browser-use MCP command should include the CLI extra'
);
assert.strictEqual(browserUseRecipe.mcpServers[0].enabled, true, 'enableMcp should enable the browser-use MCP server');
assert(browserUseRecipe.skills[0].instructions.includes('browser-use install'), 'browser-use repair skill should mention Chromium install');

console.log('SUCCESS link-importer');
