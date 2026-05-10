const assert = require('assert');
const {
    buildClaudeMemoryHierarchy,
    buildClaudeMemoryHierarchyDetails,
    buildSystemPromptText
} = require('../src/utils/context-builder');

const memory = {
    user_profile: [
        '- User works from Asia/Shanghai.',
        '- User prefers direct repo-grounded critique.'
    ].join('\n'),
    global_context: [
        '- User works on claudish-proxy with Docker, Claude Desktop, Codex, and MiniMax.',
        '- User prefers preserving Claude-facing aliases while MiniMax stays hidden upstream.',
        '- Previous alias rewrite was completed for nested SSE message_start payloads.'
    ].join('\n'),
    active_projects: [
        { name: 'claudish-proxy', status: 'active', summary: 'Local Claude-compatible proxy for MiniMax and OpenAI-compatible routes.' }
    ],
    integrations: {
        minimax: { status: 'active', summary: 'Primary M2.7 backend.' },
        docker: { status: 'active', summary: 'Containerized localhost gateway.' }
    },
    recent_events: Array.from({ length: 15 }, (_, index) => ({
        timestamp: `2026-05-${String(index + 1).padStart(2, '0')}`,
        summary: `Recent event ${index + 1}`,
        source: 'test'
    })),
    conversation_checkpoints: [
        { topic: 'UI', summary: 'Fix current config secret display.', timestamp: '2026-05-10' },
        { topic: 'Adapters', summary: 'Completed previous OpenAI streaming parse fix.', timestamp: '2026-05-09' }
    ]
};

const hierarchy = buildClaudeMemoryHierarchy(memory);

[
    'Work context',
    'Personal context',
    'Top of mind',
    'Brief history',
    'Recent months',
    'Earlier context',
    'Long-term background'
].forEach(section => assert(hierarchy.includes(section), `missing section: ${section}`));

assert(hierarchy.includes('Recent event 15'), 'recent events should not be truncated');
assert(hierarchy.includes('Local Claude-compatible proxy'), 'active project details should be present');
assert(hierarchy.includes('direct repo-grounded critique'), 'personal profile should be present');

const systemPrompt = buildSystemPromptText('Client says preserve tools.', {
    model: 'MiniMax-M2.7',
    targetUrl: 'https://api.minimax.io/anthropic/v1/messages',
    memory,
    skills: [{
        name: 'mcp_guard',
        enabled: true,
        trigger: 'when tools are present',
        instructions: 'Preserve Claude-visible MCP tool names.'
    }]
});

assert(systemPrompt.includes('<minimax_m2_7_instructions>'), 'MiniMax instruction wrapper missing');
assert(systemPrompt.includes('<proxy_self_awareness source="claudish-proxy" applies_to="all_models">'), 'proxy self-awareness wrapper missing');
assert(systemPrompt.includes('mcp__cowork__*'), 'Cowork compatibility guidance should be present');
assert(systemPrompt.includes('<august_global_context format="claude_memory_hierarchy" source="august_core_memory.json">'), 'global context wrapper missing');
assert(systemPrompt.includes('<custom_skills source="config.customSkills">'), 'custom skills wrapper missing');
assert(systemPrompt.includes('<client_system_prompt>'), 'client system prompt wrapper missing');
assert(systemPrompt.includes('Client says preserve tools.'), 'client system prompt content missing');

const largeMemory = {
    ...memory,
    recent_events: Array.from({ length: 260 }, (_, index) => ({
        timestamp: `2026-05-${String((index % 30) + 1).padStart(2, '0')}`,
        summary: `Current claudish-proxy MCP plugin import workflow detail ${index}: preserve Claude Desktop visible tools, August Brain context, MiniMax continuity, and local proxy self-healing while avoiding repeated filler.`,
        source: 'compaction-test'
    })),
    conversation_checkpoints: Array.from({ length: 90 }, (_, index) => ({
        topic: 'Proxy',
        summary: `Active blocker ${index}: custom skill and MCP server link import should stay visible through Cowork compatibility tools.`,
        timestamp: '2026-05-10'
    }))
};

const compacted = buildClaudeMemoryHierarchyDetails(largeMemory, { maxChars: 9000 });
assert.strictEqual(compacted.compacted, true, 'large memory should be compacted');
assert(compacted.finalLength <= compacted.maxChars, 'compacted context should respect maxChars');
assert(compacted.text.includes('Context compaction'), 'compaction note missing');
assert(compacted.text.includes('Work context'), 'compacted hierarchy should preserve Claude section labels');

console.log('SUCCESS context-builder');
