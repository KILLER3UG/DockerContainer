const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mod = require('../src/utils/subagent-config');

const {
    getDefaultSubagentConfig,
    loadSubagentConfig,
    subagentConfigToContextBlock
} = mod;

(async () => {
    // ── getDefaultSubagentConfig ──
    const def = getDefaultSubagentConfig();
    assert.strictEqual(def.current.name, 'default');
    assert.strictEqual(typeof def.current.system_prompt, 'string');
    assert.strictEqual(def.current.max_loops, 5);
    assert.strictEqual(typeof def.current.score.completion_rate, 'number');
    assert.deepStrictEqual(def.history, []);
    assert.deepStrictEqual(def.observed_patterns, []);
    assert.strictEqual(def.metadata.total_spawns, 0);
    assert.strictEqual(def.metadata.total_learnings, 0);

    // ── loadSubagentConfig (should load from disk if file exists) ──
    const config = loadSubagentConfig();
    assert.strictEqual(typeof config.current.name, 'string');
    assert(Array.isArray(config.history));

    // ── subagentConfigToContextBlock ──
    const block = subagentConfigToContextBlock();
    assert(block.includes('[August Sub-agent System]'), 'block includes header');
    assert(block.includes('Current strategy:'), 'block includes strategy');
    assert(block.includes('Score:'), 'block includes score');
    assert(block.includes('Total spawns:'), 'block includes spawns');
    assert(block.includes('You can improve'), 'block includes improvement hint');

    // ── Verify the real config file exists (smoke check) ──
    const realFile = mod.SUBAGENT_CONFIG_FILE;
    assert(fs.existsSync(realFile), 'subagent config file should exist on disk');

    console.log('SUCCESS subagent-config');
})();
