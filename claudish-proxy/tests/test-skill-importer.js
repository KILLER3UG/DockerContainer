const assert = require('assert');
const {
    buildGithubSearchQueries,
    isHttpUrl,
    summarizeResolvedCapability
} = require('../src/utils/skill-importer');
const { getAugustToolDefinitions, executeAugustToolCall } = require('../src/utils/august-tools');

(async () => {
    const queries = buildGithubSearchQueries('browser automation');
    assert(queries.some(query => query.includes('SKILL.md')), 'search should look for SKILL.md repositories');
    assert(queries.some(query => query.includes('codex skill')), 'search should include Codex skill wording');
    assert.strictEqual(isHttpUrl('https://github.com/example/repo'), true, 'GitHub URLs should be recognized');
    assert.strictEqual(isHttpUrl('browser automation'), false, 'plain search text should not be treated as a URL');

    const summary = summarizeResolvedCapability({
        resolvedUrl: 'https://raw.githubusercontent.com/example/repo/main/SKILL.md',
        attemptedUrls: ['https://raw.githubusercontent.com/example/repo/main/SKILL.md'],
        skills: [{
            name: 'repo_skill',
            description: 'Repository helper',
            trigger: 'When repo help is needed.',
            enabled: true
        }],
        mcpServers: [{
            name: 'repo-mcp',
            command: 'npx',
            args: ['-y', 'repo-mcp'],
            enabled: false
        }],
        plugins: [{
            name: 'repo-plugin',
            description: 'Repository plugin',
            sourceUrl: 'https://github.com/example/repo',
            skills: [{}],
            mcpServers: [{}],
            enabled: true
        }]
    }, 'https://github.com/example/repo');

    assert.strictEqual(summary.installable, true, 'summary should report installable content');
    assert.strictEqual(summary.skills[0].name, 'repo_skill', 'skill summary should preserve name');
    assert.strictEqual(summary.mcpServers[0].enabled, false, 'MCP preview should preserve disabled state');
    assert(summary.note.includes('Nothing was saved'), 'preview summary should clarify it is read-only');

    const names = getAugustToolDefinitions().map(tool => tool.function?.name).filter(Boolean);
    assert(names.includes('august__find_skill_sources'), 'August skill discovery tool should be registered');
    assert(names.includes('august__preview_skill_import'), 'August skill preview tool should be registered');
    assert(names.includes('august__import_skill'), 'August skill import tool should be registered');

    const confirmation = await executeAugustToolCall('august__import_skill', {
        url: 'https://github.com/example/repo'
    });
    assert(String(confirmation).includes('August Confirmation Required'), 'August import should require confirmation before saving');

    console.log('SUCCESS skill-importer');
})();
