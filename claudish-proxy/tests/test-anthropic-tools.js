const assert = require('assert');
const {
    MANAGED_WEB_TOOL_NAMES,
    isManagedWebToolName,
    getManagedWebToolKind,
    sanitizeAnthropicToolDefinition,
    dedupeAndCanonicalizeAnthropicTools,
    getToolDefinitionName,
    appendMissingAnthropicTools,
    appendMissingOpenAiTools,
    isProxyManagedLocalToolName,
    isBrowserAutomationToolName,
    buildClientToolGuidance,
    openAiToAnthropicToolDefinition,
    anthropicToOpenAiToolDefinition
} = require('../src/adapters/anthropic-tools');

(async () => {
    // ── isManagedWebToolName ──
    assert.strictEqual(isManagedWebToolName('WebSearch'), true);
    assert.strictEqual(isManagedWebToolName('WebFetch'), true);
    assert.strictEqual(isManagedWebToolName('web_search'), true);
    assert.strictEqual(isManagedWebToolName('mcp__workspace__web_search'), true);
    assert.strictEqual(isManagedWebToolName('bogus'), false);
    assert.strictEqual(isManagedWebToolName(null), false);
    assert.strictEqual(isManagedWebToolName(42), false);

    // ── getManagedWebToolKind ──
    assert.strictEqual(getManagedWebToolKind('WebSearch'), 'search');
    assert.strictEqual(getManagedWebToolKind('web_search'), 'search');
    assert.strictEqual(getManagedWebToolKind('mcp__workspace__web_search'), 'search');
    assert.strictEqual(getManagedWebToolKind('WebFetch'), 'fetch');
    assert.strictEqual(getManagedWebToolKind('web_fetch'), 'fetch');
    assert.strictEqual(getManagedWebToolKind('mcp__workspace__web_fetch'), 'fetch');
    assert.strictEqual(getManagedWebToolKind(null), null);
    assert.strictEqual(getManagedWebToolKind('nope'), null);

    // ── sanitizeAnthropicToolDefinition ──
    assert.strictEqual(sanitizeAnthropicToolDefinition(null), null);
    assert.strictEqual(sanitizeAnthropicToolDefinition({}), null, 'no name');

    const simple = sanitizeAnthropicToolDefinition({ name: 'test_tool', description: 'Does stuff', input_schema: { type: 'object', properties: {} } });
    assert.strictEqual(simple.name, 'test_tool');
    assert.strictEqual(simple.description, 'Does stuff');

    const fromFunction = sanitizeAnthropicToolDefinition({
        type: 'function',
        function: { name: 'fn_tool', description: 'From fn', parameters: { type: 'object' } }
    });
    assert.strictEqual(fromFunction.name, 'fn_tool');
    assert.strictEqual(fromFunction.description, 'From fn');

    const missingSchema = sanitizeAnthropicToolDefinition({ name: 'no_schema' });
    assert(missingSchema.input_schema, 'should default input_schema');
    assert.strictEqual(missingSchema.input_schema.type, 'object');

    // ── dedupeAndCanonicalizeAnthropicTools ──
    const deduped = dedupeAndCanonicalizeAnthropicTools([
        { name: 'tool_a', input_schema: { type: 'object', properties: {} } },
        { name: 'tool_a', input_schema: { type: 'object', properties: {} } },
        { name: 'WebSearch', input_schema: { type: 'object', properties: {} } },
        { name: 'tool_b', input_schema: { type: 'object', properties: {} } }
    ]);
    const names = deduped.map(t => t.name);
    assert(names.includes('tool_a'), 'should include tool_a');
    assert(names.includes('tool_b'), 'should include tool_b');
    assert(names.includes('WebSearch'), 'should include WebSearch managed tool');
    assert(names.includes('mcp__workspace__web_search'), 'includes canonical workspace alias');
    // tool_a should appear only once
    assert.strictEqual(names.filter(n => n === 'tool_a').length, 1, 'no duplicates');

    // ── getToolDefinitionName ──
    assert.strictEqual(getToolDefinitionName({ name: 'foo' }), 'foo');
    assert.strictEqual(getToolDefinitionName({ function: { name: 'bar' } }), 'bar');
    assert.strictEqual(getToolDefinitionName({}), '');
    assert.strictEqual(getToolDefinitionName(null), '');

    // ── appendMissingAnthropicTools ──
    const target1 = [{ name: 'existing', input_schema: { type: 'object', properties: {} } }];
    const appended1 = appendMissingAnthropicTools(target1, [
        { name: 'existing', input_schema: { type: 'object', properties: {} } },
        { name: 'new_tool', input_schema: { type: 'object', properties: {} } }
    ]);
    assert.strictEqual(target1.length, 2, 'should only append missing');
    assert.deepStrictEqual(appended1, ['new_tool']);

    // ── appendMissingOpenAiTools ──
    const target2 = [{ function: { name: 'existing' } }];
    const appended2 = appendMissingOpenAiTools(target2, [
        { function: { name: 'existing' } },
        { function: { name: 'new_oa' } }
    ]);
    assert.strictEqual(target2.length, 2);
    assert.deepStrictEqual(appended2, ['new_oa']);

    // ── isBrowserAutomationToolName ──
    assert.strictEqual(isBrowserAutomationToolName('browser_navigate'), true);
    assert.strictEqual(isBrowserAutomationToolName('browser_click'), true);
    assert.strictEqual(isBrowserAutomationToolName('chrome'), true);
    assert.strictEqual(isBrowserAutomationToolName('list_connected_browsers'), true);
    assert.strictEqual(isBrowserAutomationToolName('workbench_read_file'), false);
    assert.strictEqual(isBrowserAutomationToolName(null), false);
    assert.strictEqual(isBrowserAutomationToolName(123), false);

    // ── buildClientToolGuidance ──
    const guidance = buildClientToolGuidance([
        { name: 'WebSearch' },
        { name: 'mcp__cowork__read_widget_context' },
        { name: 'workbench_read_file' }
    ]);
    assert(guidance.includes('[CLIENT TOOL INVENTORY]'), 'should include header');
    assert(guidance.includes('WebSearch'), 'should list visible tools');
    assert(guidance.includes('cowork'), 'should include cowork guidance');
    assert(guidance.includes('web-fetch'), 'should include web guidance');
    assert.strictEqual(buildClientToolGuidance([]), '', 'empty array returns empty');
    assert.strictEqual(buildClientToolGuidance(null), '', 'null returns empty');

    // ── openAiToAnthropicToolDefinition ──
    const converted = openAiToAnthropicToolDefinition({
        type: 'function',
        function: { name: 'oa_tool', description: 'OA desc', parameters: { type: 'object' } }
    });
    assert.strictEqual(converted.name, 'oa_tool');
    assert.strictEqual(converted.description, 'OA desc');

    // ── anthropicToOpenAiToolDefinition ──
    const backToOpenAi = anthropicToOpenAiToolDefinition({ name: 'ant_tool', description: 'Ant desc', input_schema: { type: 'object' } });
    assert.strictEqual(backToOpenAi.function.name, 'ant_tool');
    assert.strictEqual(backToOpenAi.function.description, 'Ant desc');
    assert.strictEqual(backToOpenAi.type, 'function');

    console.log('SUCCESS anthropic-tools');
})();
