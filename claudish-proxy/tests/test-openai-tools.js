const assert = require('assert');
const {
    isManagedWebToolName,
    isProxyManagedLocalToolName,
    getToolDefinitionName,
    appendMissingOpenAiTools,
    getCanonicalManagedOpenAiWebTools
} = require('../src/adapters/openai-tools');

(async () => {
    // ── isManagedWebToolName ──
    assert.strictEqual(isManagedWebToolName('WebSearch'), true);
    assert.strictEqual(isManagedWebToolName('WebFetch'), true);
    assert.strictEqual(isManagedWebToolName('mcp__workspace__web_search'), true);
    assert.strictEqual(isManagedWebToolName('unknown'), false);
    assert.strictEqual(isManagedWebToolName(null), false);

    // ── isProxyManagedLocalToolName ──
    assert.strictEqual(isProxyManagedLocalToolName('WebSearch'), true);
    assert.strictEqual(isProxyManagedLocalToolName('august__bash'), true);
    assert.strictEqual(isProxyManagedLocalToolName('mcp__filesystem__read_file'), true);
    assert.strictEqual(isProxyManagedLocalToolName('mcp__cowork__request_cowork_directory'), true, 'cowork tools are managed');
    assert.strictEqual(isProxyManagedLocalToolName('random_tool'), false);

    // ── getToolDefinitionName ──
    assert.strictEqual(getToolDefinitionName({ name: 'foo' }), 'foo');
    assert.strictEqual(getToolDefinitionName({ function: { name: 'bar' } }), 'bar');
    assert.strictEqual(getToolDefinitionName({}), '');
    assert.strictEqual(getToolDefinitionName(null), '');

    // ── appendMissingOpenAiTools ──
    const target = [{ function: { name: 'existing' } }];
    const appended = appendMissingOpenAiTools(target, [
        { function: { name: 'existing' } },
        { function: { name: 'new_tool' } }
    ]);
    assert.strictEqual(target.length, 2, 'should append only missing');
    assert.deepStrictEqual(appended, ['new_tool']);
    assert.strictEqual(target[1].function.name, 'new_tool');

    // ── getCanonicalManagedOpenAiWebTools ──
    const canonicalTools = getCanonicalManagedOpenAiWebTools();
    const canonicalNames = canonicalTools.map(t => t.function.name);
    assert(canonicalNames.includes('WebSearch'), 'includes WebSearch');
    assert(canonicalNames.includes('WebFetch'), 'includes WebFetch');
    assert(canonicalNames.includes('mcp__workspace__web_search'), 'includes workspace search');
    assert(canonicalNames.includes('mcp__workspace__web_fetch'), 'includes workspace fetch');
    canonicalTools.forEach(t => {
        assert.strictEqual(t.type, 'function');
        assert(t.function.name, 'each tool has a name');
        assert(t.function.description, 'each tool has a description');
        assert(t.function.parameters, 'each tool has parameters');
    });

    console.log('SUCCESS openai-tools');
})();
