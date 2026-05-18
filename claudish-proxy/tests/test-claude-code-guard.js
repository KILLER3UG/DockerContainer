const assert = require('assert');
const {
    CLAUDE_CODE_NATIVE_GUARD,
    appendTextToSystemBlocks,
    buildClaudeCodeNativeGuidance,
    hasClaudeCodeNativeTooling
} = require('../src/adapters/anthropic');

(async () => {
    assert.strictEqual(hasClaudeCodeNativeTooling([{ name: 'Agent' }]), true);
    assert.strictEqual(hasClaudeCodeNativeTooling([{ name: 'Bash' }]), true);
    assert.strictEqual(hasClaudeCodeNativeTooling([{ name: 'workbench_read_file' }]), false);
    assert.strictEqual(buildClaudeCodeNativeGuidance([{ name: 'Read' }]), CLAUDE_CODE_NATIVE_GUARD);
    assert.strictEqual(buildClaudeCodeNativeGuidance([{ name: 'WebFetch' }]), '');

    const appended = appendTextToSystemBlocks([{ type: 'text', text: 'base' }], 'guard');
    assert.strictEqual(appended[0].text, 'base\n\n---\n\nguard');

    const created = appendTextToSystemBlocks([{ type: 'image', source: {} }], 'guard');
    assert.strictEqual(created[0].type, 'text');
    assert.strictEqual(created[0].text, 'guard');
    assert.strictEqual(created[1].type, 'image');

    assert(CLAUDE_CODE_NATIVE_GUARD.includes('wait for explicit user approval'), 'guard should require approval');
    assert(CLAUDE_CODE_NATIVE_GUARD.includes('no project files were changed'), 'guard should clarify read-only results');

    console.log('SUCCESS claude-code-guard');
})();
