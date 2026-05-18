const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    WORKSPACE_ROOT,
    approveWorkbenchPlan,
    clearWorkbenchGoal,
    createWorkbenchSession,
    executeWorkbenchTool,
    getWorkbenchGoalStatus,
    getWorkbenchSession,
    listAgentRegistry,
    setWorkbenchGoal
} = require('../src/utils/workbench');
const { deriveChildAgentPermissions } = require('../src/utils/agent-registry');

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

    const blockedCommand = await executeWorkbenchTool(session, {
        name: 'workbench_run_command',
        input: { command: 'Write-Output "blocked until approval"' }
    });
    assert.strictEqual(blockedCommand.blocked, true, 'commands should be blocked before plan approval');

    const blockedSkillImport = await executeWorkbenchTool(session, {
        name: 'workbench_import_skill',
        input: { url: 'https://github.com/example/example-skill' }
    });
    assert.strictEqual(blockedSkillImport.blocked, true, 'skill imports should be blocked before plan approval');

    const blockedOutsideWrite = await executeWorkbenchTool(session, {
        name: 'workbench_write_file',
        input: { path: path.join(WORKSPACE_ROOT, '..', '.workbench-outside-gate.tmp'), content: 'blocked' }
    });
    assert.strictEqual(blockedOutsideWrite.blocked, true, 'writes outside proxy root should still require approval');

    const diagnostics = await executeWorkbenchTool(session, {
        name: 'workbench_diagnose_proxy',
        input: { include_activity: false }
    });
    assert(diagnostics.brain, 'diagnostics should include brain status');
    assert(diagnostics.capabilities, 'diagnostics should include capability inventory');

    const environment = await executeWorkbenchTool(session, {
        name: 'workbench_describe_environment',
        input: {}
    });
    assert(environment.roots.projectRoot, 'environment should include project root');
    assert(environment.roots.workspaceRoot, 'environment should include workspace root');
    assert(environment.roots.hostProjectRoots.length >= 1, 'environment should include host project root mappings');

    const hostPathRead = await executeWorkbenchTool(session, {
        name: 'workbench_read_file',
        input: {
            path: path.join(path.resolve(__dirname, '..'), 'src', 'bridge.js'),
            max_chars: 1000
        }
    });
    assert.strictEqual(hostPathRead.path, 'bridge.js', 'absolute host project paths should map to the Workbench source tree once');
    assert(hostPathRead.content.includes("const http = require('http')"), 'host path read should return bridge.js content');

    const capabilities = await executeWorkbenchTool(session, {
        name: 'workbench_list_proxy_capabilities',
        input: {}
    });
    assert(capabilities.groups.workbench.some(tool => tool.name === 'workbench_diagnose_proxy'), 'diagnostic tool should be visible to workbench');
    assert(capabilities.groups.workbench.some(tool => tool.name === 'workbench_describe_environment'), 'environment tool should be visible to workbench');
    assert(capabilities.groups.workbench.some(tool => tool.name === 'workbench_list_agent_registry'), 'agent registry tool should be visible to workbench');
    assert(capabilities.groups.workbench.some(tool => tool.name === 'workbench_find_skill_sources'), 'skill source finder should be visible to workbench');
    assert(capabilities.groups.workbench.some(tool => tool.name === 'workbench_preview_skill_import' && tool.mutating === false), 'skill import preview should be non-mutating');
    assert(capabilities.groups.workbench.some(tool => tool.name === 'workbench_import_skill' && tool.mutating === true), 'skill import should be marked mutating');
    assert(capabilities.groups.web.some(tool => tool.name === 'WebFetch'), 'Claude-compatible web aliases should be visible to workbench');
    assert(capabilities.agents.agents.some(agent => agent.id === 'explore'), 'capability inventory should include agent registry');

    const registry = await executeWorkbenchTool(session, {
        name: 'workbench_list_agent_registry',
        input: { parent_agent_id: 'plan' }
    });
    assert(registry.agents.some(agent => agent.id === 'build'), 'agent registry should include build');
    assert(registry.agents.some(agent => agent.id === 'plan'), 'agent registry should include plan');
    assert(registry.agents.some(agent => agent.id === 'explore'), 'agent registry should include explore');
    assert(registry.agents.some(agent => agent.id === 'general'), 'agent registry should include general');
    const inheritedGeneral = registry.agents.find(agent => agent.id === 'general');
    assert.strictEqual(inheritedGeneral.effectivePermissions.edit, 'deny', 'plan parent should deny inherited child edits');

    const directRegistry = listAgentRegistry('build');
    assert(directRegistry.agents.some(agent => agent.id === 'general'), 'direct registry export should include general agent');
    const directGeneral = directRegistry.agents.find(agent => agent.id === 'general');
    assert.strictEqual(directGeneral.effectivePermissions.edit, 'deny', 'general subagent should not inherit edit access');

    const explorePermissions = deriveChildAgentPermissions('build', 'explore');
    const subagentRead = await executeWorkbenchTool(session, {
        name: 'workbench_read_file',
        input: { path: 'src/bridge.js', max_chars: 500 }
    }, {
        agentId: 'explore',
        parentAgentId: 'build',
        inheritedPermissions: explorePermissions
    });
    assert(subagentRead.content.includes("const http = require('http')"), 'explore subagent should be allowed to read files');

    const subagentWrite = await executeWorkbenchTool(session, {
        name: 'workbench_write_file',
        input: { path: TMP_REL, content: 'subagent-denied' }
    }, {
        agentId: 'explore',
        parentAgentId: 'build',
        inheritedPermissions: explorePermissions
    });
    assert.strictEqual(subagentWrite.blocked, true, 'explore subagent should be blocked from editing');
    assert(subagentWrite.message.includes('AGENT PERMISSION GUARD'), 'subagent edit block should come from agent permission guard');

    const goal = setWorkbenchGoal(session, 'All focused tests pass.');
    assert.strictEqual(goal.status, 'active', 'setting a Workbench goal should mark it active');
    assert.strictEqual(getWorkbenchGoalStatus(session.id).goal.condition, 'All focused tests pass.', 'goal status should be readable');
    const clearedGoal = clearWorkbenchGoal(session, 'test clear');
    assert.strictEqual(clearedGoal.status, 'cleared', 'clearing a Workbench goal should preserve last goal state');
    assert.strictEqual(getWorkbenchGoalStatus(session.id).goal, null, 'cleared goal should no longer be active');

    const planResult = await executeWorkbenchTool(session, {
        name: 'workbench_submit_plan',
        input: {
            summary: 'Write and verify a temporary test file.',
            steps: ['Create a temp file', 'Run a harmless verification command', 'Verify the file exists'],
            files: [TMP_REL],
            verification: ['Read the file', 'Run a PowerShell echo command']
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

    const commandResult = await executeWorkbenchTool(session, {
        name: 'workbench_run_command',
        input: { command: 'Write-Output "approved"', timeout_ms: 5000 }
    });
    assert.strictEqual(commandResult.status, 'ok');
    assert(commandResult.stdout.includes('approved'), 'approved command should run');
    assert.strictEqual(session.mutationLog.length, 2, 'approved write and command should be recorded in the mutation audit');
    assert.strictEqual(session.mutationLog[0].toolName, 'workbench_write_file', 'mutation audit should record the write tool');
    assert.strictEqual(session.mutationLog[1].toolName, 'workbench_run_command', 'mutation audit should record the command tool');

    const planSummary = createWorkbenchSession({ agentId: 'plan' });
    const planSession = getWorkbenchSession(planSummary.id);
    await executeWorkbenchTool(planSession, {
        name: 'workbench_submit_plan',
        input: {
            summary: 'Attempt a write from plan mode.',
            steps: ['Confirm plan-mode agent guard denies writes'],
            files: [TMP_REL]
        }
    });
    approveWorkbenchPlan(planSession.id);
    const planWrite = await executeWorkbenchTool(planSession, {
        name: 'workbench_write_file',
        input: { path: TMP_REL, content: 'should-not-write' }
    });
    assert.strictEqual(planWrite.blocked, true, 'plan agent should still be blocked from writes after approval');
    assert(planWrite.message.includes('AGENT PERMISSION GUARD'), 'plan write should include agent permission guard message');

    const tmpPath = path.join(WORKSPACE_ROOT, '.workbench-gate.tmp');
    assert.strictEqual(fs.readFileSync(tmpPath, 'utf8'), 'approved');
    fs.unlinkSync(tmpPath);

    console.log('SUCCESS workbench');
})();
