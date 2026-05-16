const assert = require('assert');
const { listMemoryItems } = require('../src/utils/memory-lifecycle');

const memory = {
    active_projects: [
        {
            name: 'claudish-proxy',
            summary: 'Fix MCP plugin import, Blender MCP enablement, and August Brain lifecycle.',
            status: 'in_progress',
            pinned: true,
            confidence: 1
        }
    ],
    integrations: {
        blender: {
            summary: 'Local Blender MCP server using host.docker.internal:9876.',
            lifecycleStatus: 'stale',
            confidence: 0.4
        }
    },
    recent_events: [
        { summary: 'Resolved older UI issue.', lifecycleStatus: 'archived' }
    ],
    conversation_checkpoints: [
        { topic: 'MCP', summary: 'Custom servers can be enabled from the dashboard.' }
    ]
};

const items = listMemoryItems(memory);
const project = items.find(item => item.type === 'project' && item.title === 'claudish-proxy');
const blender = items.find(item => item.type === 'integration' && item.title === 'blender');
const archived = items.find(item => item.type === 'event');

assert(project, 'project memory should be listed');
assert.strictEqual(project.key, '0', 'project memory should use stable index keys');
assert.strictEqual(project.pinned, true, 'pinned lifecycle metadata should be preserved');
assert(project.injection.score >= blender.injection.score, 'active proxy work should score highly');

assert(blender, 'integration memory should be listed');
assert.strictEqual(blender.status, 'stale', 'integration lifecycle status should be normalized');
assert.strictEqual(Math.round(blender.confidence * 10), 4, 'confidence should be clamped and preserved');

assert.strictEqual(archived.status, 'archived', 'archived event status should be preserved');

console.log('SUCCESS memory-lifecycle');
