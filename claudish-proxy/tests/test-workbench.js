const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    WORKSPACE_ROOT,
    approveWorkbenchPlan,
    createWorkbenchSession,
    executeWorkbenchTool,
    getWorkbenchSession,
    resolveWorkspacePath
} = require('../src/utils/workbench');

(async () => {
    const summary = createWorkbenchSession();
    const session = getWorkbenchSession(summary.id);

    const blocked = await executeWorkbenchTool(session, {
        name: 'workbench_write_file',
        input: { path: 'tests/.workbench-gate.tmp', content: 'blocked' }
    });
    assert.strictEqual(blocked.blocked, true, 'write should be blocked before plan approval');
    assert(blocked.error.includes('WORKBENCH APPROVAL GATE BLOCKED'), 'blocked write should include hard gate message');

    const planResult = await executeWorkbenchTool(session, {
        name: 'workbench_submit_plan',
        input: {
            summary: 'Write a temporary test file.',
            steps: ['Create a temp file', 'Verify it exists'],
            files: ['tests/.workbench-gate.tmp'],
            verification: ['Read the file']
        }
    });
    assert.strictEqual(planResult.status, 'plan_submitted_waiting_for_user_approval');
    assert.strictEqual(session.approved, false, 'submitting a plan should not auto-approve');

    approveWorkbenchPlan(session.id);
    assert.strictEqual(session.approved, true, 'explicit approval should unlock mutating tools');

    const writeResult = await executeWorkbenchTool(session, {
        name: 'workbench_write_file',
        input: { path: 'tests/.workbench-gate.tmp', content: 'approved' }
    });
    assert.strictEqual(writeResult.status, 'written');
    const tmpPath = path.join(WORKSPACE_ROOT, 'tests/.workbench-gate.tmp');
    assert.strictEqual(fs.readFileSync(tmpPath, 'utf8'), 'approved');
    fs.unlinkSync(tmpPath);

    assert.throws(() => resolveWorkspacePath('../outside.txt'), /outside the workbench workspace/);

    console.log('SUCCESS workbench');
})();
