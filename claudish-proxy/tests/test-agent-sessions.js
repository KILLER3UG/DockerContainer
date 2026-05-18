const assert = require('assert');
const fs = require('fs');

const sessions = require('../src/utils/agent-sessions');

(async () => {
    const fileExisted = fs.existsSync(sessions.AGENT_SESSIONS_FILE);
    const before = fileExisted ? fs.readFileSync(sessions.AGENT_SESSIONS_FILE, 'utf8') : '';

    try {
        const root = sessions.createAgentSession({
            id: '_test_root_session',
            title: 'Root test session',
            agent: 'build',
            task: 'Coordinate child work'
        });
        const child = sessions.createAgentSession({
            id: '_test_child_session',
            title: 'Child test session',
            agent: 'explore',
            parentId: root.id,
            task: 'Inspect a dependency'
        });

        assert.strictEqual(root.status, 'idle');
        assert.strictEqual(child.parentId, root.id);

        const todos = sessions.writeTodos(root.id, [
            { id: 'a', content: 'Inspect Hermes todo model', status: 'completed' },
            { id: 'b', content: 'Implement durable session store', status: 'in_progress' }
        ]);
        assert.strictEqual(todos.summary.total, 2);
        assert.strictEqual(todos.summary.in_progress, 1);
        assert.strictEqual(todos.state, 'clear', 'idle sessions clear stale todos');

        sessions.updateAgentSession(root.id, { status: 'running' });
        assert.strictEqual(sessions.todoState(root.id), 'open', 'running sessions show active todos');

        const merged = sessions.writeTodos(root.id, [
            { id: 'b', content: 'Implement durable session store', status: 'completed' },
            { id: 'c', content: 'Expose session UI', status: 'pending' }
        ], { merge: true });
        assert.strictEqual(merged.summary.completed, 2);
        assert.strictEqual(merged.summary.pending, 1);

        const permission = sessions.addPermissionRequest(child.id, {
            tool: 'terminal_execute',
            reason: 'child needs shell',
            payload: { command: 'node -v' }
        });
        assert.strictEqual(permission.session.status, 'blocked');
        const treeRequest = sessions.findTreeRequest(root.id, 'permission');
        assert(treeRequest, 'root should see pending child permission request');
        assert.strictEqual(treeRequest.sessionId, child.id);

        sessions.respondPermission(child.id, permission.request.id, 'once');
        assert.strictEqual(sessions.findTreeRequest(root.id, 'permission'), null);

        const question = sessions.addQuestionRequest(child.id, { question: 'Which provider should this use?' });
        assert.strictEqual(sessions.findTreeRequest(root.id, 'question').request.id, question.request.id);
        sessions.respondQuestion(child.id, question.request.id, 'local');

        sessions.updateAgentSession(root.id, { status: 'running' });
        const queued = await sessions.startSessionRun(root.id, {
            command: 'node -v',
            approved: true
        });
        assert.strictEqual(queued.status, 'queued', 'running sessions should queue follow-ups instead of starting duplicate work');

        sessions.updateAgentSession(root.id, { status: 'idle' });
        const run = await sessions.startSessionRun(root.id, {
            command: 'node -v',
            approved: true,
            timeoutMs: 5000
        });
        assert.strictEqual(run.status, 'completed');
        assert(run.result.output.includes('v'), 'safe command output should be stored');

        const cancelled = sessions.cancelAgentSession(root.id, 'test cleanup cancel');
        assert.strictEqual(cancelled.status, 'cancelled');

        const deleted = sessions.deleteAgentSession(root.id, { includeChildren: true });
        assert.strictEqual(deleted.deleted, 2);

        console.log('SUCCESS agent-sessions');
    } finally {
        if (fileExisted) fs.writeFileSync(sessions.AGENT_SESSIONS_FILE, before);
        else if (fs.existsSync(sessions.AGENT_SESSIONS_FILE)) fs.unlinkSync(sessions.AGENT_SESSIONS_FILE);
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
