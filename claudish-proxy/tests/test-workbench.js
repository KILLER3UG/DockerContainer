const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    WORKSPACE_ROOT,
    approveWorkbenchPlan,
    createWorkbenchSession,
    executeWorkbenchTool,
    getWorkbenchSession
} = require('../src/utils/workbench');

const TMP_REL = 'src/.workbench-gate.tmp';

(async () => {
    const summary = createWorkbenchSession();
    const session = getWorkbenchSession(summary.id);

    const blocked = await executeWorkbenchTool(session, {
        name: 'workbench_write_file',
        input: { path: TMP_REL, content: 'blocked' }
    });
    assert.strictEqual(blocked.blocked, true, 'write should be blocked before plan approval');
    assert(blocked.message.includes('WORKBENCH APPROVAL GATE'), 'blocked write should include hard gate message');

    const planResult = await executeWorkbenchTool(session, {
        name: 'workbench_submit_plan',
        input: {
            summary: 'Write a temporary test file.',
            steps: ['Create a temp file', 'Verify it exists'],
            files: [TMP_REL],
            verification: ['Read the file']
        }
    });
    assert.strictEqual(planResult.status, 'plan_submitted_waiting_for_user_approval');
    assert.strictEqual(session.approved, false, 'submitting a plan should not auto-approve');

    approveWorkbenchPlan(session.id);
    assert.strictEqual(session.approved, true, 'explicit approval should unlock mutating tools');

    const writeResult = await executeWorkbenchTool(session, {
        name: 'workbench_write_file',
        input: { path: TMP_REL, content: 'approved' }
    });
    assert.strictEqual(writeResult.status, 'written');
    const tmpPath = path.join(WORKSPACE_ROOT, '.workbench-gate.tmp');
    assert.strictEqual(fs.readFileSync(tmpPath, 'utf8'), 'approved');
    fs.unlinkSync(tmpPath);

    console.log('SUCCESS workbench');
})();
