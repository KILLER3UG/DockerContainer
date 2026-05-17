const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mod = require('../src/utils/core-memory');

const {
    getDefaultAugustCoreMemory,
    normalizeAugustCoreMemory,
    renderAugustCoreMemory,
    upsertProject,
    upsertIntegration,
    appendRecentEvent,
    appendCheckpoint
} = mod;

(async () => {
    // ── getDefaultAugustCoreMemory ──
    const def = getDefaultAugustCoreMemory();
    assert.strictEqual(typeof def.user_profile, 'string');
    assert.strictEqual(typeof def.global_context, 'string');
    assert.deepStrictEqual(def.active_projects, []);
    assert.deepStrictEqual(def.integrations, {});
    assert.deepStrictEqual(def.recent_events, []);
    assert.deepStrictEqual(def.conversation_checkpoints, []);

    // ── normalizeAugustCoreMemory ──
    const normalized = normalizeAugustCoreMemory(null);
    assert.strictEqual(typeof normalized.user_profile, 'string');
    assert.strictEqual(Array.isArray(normalized.active_projects), true);

    const withBadTypes = normalizeAugustCoreMemory({
        user_profile: 123,
        active_projects: 'not-array',
        integrations: 'not-object',
        recent_events: { not: 'array' },
        conversation_checkpoints: null
    });
    assert.strictEqual(typeof withBadTypes.user_profile, 'string', 'user_profile coerced to string');
    assert.deepStrictEqual(withBadTypes.active_projects, [], 'projects coerced to array');
    assert.deepStrictEqual(withBadTypes.integrations, {}, 'integrations coerced to object');

    const filtered = normalizeAugustCoreMemory({
        active_projects: [{ name: 'valid' }, { no_name: true }, null],
        recent_events: [{ summary: 'event1' }, { no_summary: true }],
        conversation_checkpoints: [{ summary: 'cp1' }, {}]
    });
    assert.strictEqual(filtered.active_projects.length, 1, 'filters projects without name');
    assert.strictEqual(filtered.active_projects[0].name, 'valid');
    assert.strictEqual(filtered.recent_events.length, 1, 'filters events without summary');
    assert.strictEqual(filtered.conversation_checkpoints.length, 1, 'filters checkpoints without summary');

    // ── renderAugustCoreMemory ──
    const rendered = renderAugustCoreMemory({ user_profile: 'UP', global_context: 'GC' });
    assert.strictEqual(rendered.user_profile, 'UP');
    assert.strictEqual(rendered.global_context, 'GC');
    assert(rendered.active_projects.includes('none recorded'));
    assert(rendered.integrations.includes('none recorded'));
    assert(rendered.recent_events.includes('none recorded'));
    assert(rendered.conversation_checkpoints.includes('none recorded'));

    const renderedWithData = renderAugustCoreMemory({
        active_projects: [{ name: 'proj1', status: 'active', summary: 'test project' }],
        integrations: { slack: { status: 'connected', summary: 'Slack bot' } },
        recent_events: [{ summary: 'did something', timestamp: '2024-01-01' }],
        conversation_checkpoints: [{ topic: 'bug', summary: 'fixed bug' }]
    });
    assert(renderedWithData.active_projects.includes('proj1'));
    assert(renderedWithData.integrations.includes('slack'));
    assert(renderedWithData.recent_events.includes('2024-01-01'));
    assert(renderedWithData.recent_events.includes('did something'));
    assert(renderedWithData.conversation_checkpoints.includes('bug'));
    assert(renderedWithData.conversation_checkpoints.includes('fixed bug'));

    // ── upsertProject ──
    const mem1 = upsertProject({}, { name: 'new-project', status: 'active', summary: 'A new project' });
    assert.strictEqual(mem1.active_projects.length, 1);
    assert.strictEqual(mem1.active_projects[0].name, 'new-project');

    const mem2 = upsertProject(mem1, { name: 'new-project', summary: 'Updated summary' });
    assert.strictEqual(mem2.active_projects.length, 1, 'updates existing project');
    assert.strictEqual(mem2.active_projects[0].summary, 'Updated summary');

    // ── upsertIntegration ──
    const mem3 = upsertIntegration({}, { name: 'github', status: 'connected' });
    assert.strictEqual(mem3.integrations.github.status, 'connected');

    const mem4 = upsertIntegration(mem3, { name: 'github', status: 'disconnected' });
    assert.strictEqual(mem4.integrations.github.status, 'disconnected', 'updates existing integration');

    // ── appendRecentEvent ──
    const mem5 = appendRecentEvent({}, { summary: 'an event', source: 'test' });
    assert.strictEqual(mem5.recent_events.length, 1);
    assert.strictEqual(mem5.recent_events[0].summary, 'an event');
    assert.strictEqual(mem5.recent_events[0].source, 'test');
    assert(mem5.recent_events[0].timestamp, 'should have timestamp');

    // ── appendCheckpoint ──
    const mem6 = appendCheckpoint({}, { topic: 'plan', summary: 'completed plan' });
    assert.strictEqual(mem6.conversation_checkpoints.length, 1);
    assert.strictEqual(mem6.conversation_checkpoints[0].topic, 'plan');

    // ── Verify real file exists (integration smoke-check) ──
    const realFile = mod.CORE_MEMORY_FILE;
    assert(fs.existsSync(realFile), 'core memory file should exist on disk');
    const raw = JSON.parse(fs.readFileSync(realFile, 'utf8'));
    assert.strictEqual(typeof raw.user_profile, 'string');
    assert.strictEqual(typeof raw.global_context, 'string');

    console.log('SUCCESS core-memory');
})();
