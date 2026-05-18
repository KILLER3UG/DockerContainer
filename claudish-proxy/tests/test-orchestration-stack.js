const assert = require('assert');
const fs = require('fs');

const sqliteStore = require('../src/utils/sqlite-memory-store');
const providers = require('../src/utils/memory-providers');
const agents = require('../src/utils/agent-registry');
const terminal = require('../src/utils/terminal-service');
const automations = require('../src/utils/automation-jobs');
const governance = require('../src/utils/memory-governance');
const { readAugustCoreMemory, writeAugustCoreMemory } = require('../src/utils/core-memory');

(async () => {
    const sync = sqliteStore.syncVectorEntries([
        {
            id: '_test_sqlite_memory',
            topic: 'August SQLite Memory',
            summary: 'SQLite FTS mirrors vector entries for hybrid memory retrieval.',
            metadata: { project: 'claudish-proxy', type: 'episode', tags: ['sqlite', 'memory'] }
        }
    ]);
    assert(sync.driver, 'SQLite store should report a driver');

    const status = sqliteStore.getMemoryStoreStatus();
    assert(status.driver, 'memory store status should include driver');
    if (status.available) {
        const results = sqliteStore.searchMemoryFts('sqlite memory retrieval', { limit: 5 });
        assert(results.some(item => item.id === '_test_sqlite_memory'), 'SQLite FTS should find mirrored memory');
    }

    const providerList = providers.listMemoryProviders();
    assert(providerList.some(item => item.id === 'vector'), 'vector memory provider should be registered');
    assert(providerList.some(item => item.id === 'sqlite'), 'sqlite memory provider should be registered');
    const providerEvent = sqliteStore.recordProviderEvent('sqlite', 'sync_turn', { session_id: '_test_session' });
    try {
        assert(
            sqliteStore.listProviderEvents({ limit: 5 }).some(item => item.providerId === 'sqlite' && item.hook === 'sync_turn'),
            'provider hook events should be queryable for the dashboard'
        );
    } finally {
        if (providerEvent.id) sqliteStore.deleteProviderEvent(providerEvent.id);
    }

    const inherited = agents.deriveChildAgentPermissions('plan', 'general');
    assert.strictEqual(inherited.edit, 'deny', 'plan agent edit deny should flow into child agents');
    assert.strictEqual(agents.evaluateAgentTool('plan', 'august__write_file').action, 'deny', 'plan agent should deny edit tools');

    assert(terminal.isDangerousCommand('rm -rf /tmp/test'), 'dangerous command detector should catch recursive delete');
    const safeCommand = `"${process.execPath}" -v`;
    const commandResult = await terminal.submitTerminalCommand({ command: safeCommand, approved: true });
    assert(['completed', 'error'].includes(commandResult.status), 'terminal command should complete or return a command error');
    assert(commandResult.output || commandResult.exitCode !== undefined, 'terminal command should return output metadata');
    const timeoutCommand = `"${process.execPath}" -e "setTimeout(()=>{}, 2000)"`;
    const timeoutResult = await terminal.submitTerminalCommand({ command: timeoutCommand, approved: true, timeoutMs: 100 });
    assert.strictEqual(timeoutResult.status, 'timeout', 'terminal command timeout should stop long-running commands');

    const memoryBeforeAutomation = readAugustCoreMemory();
    const automationFileExisted = fs.existsSync(automations.AUTOMATION_FILE);
    const automationBefore = automationFileExisted ? fs.readFileSync(automations.AUTOMATION_FILE, 'utf8') : '';
    try {
        const job = automations.saveAutomationJob({
            id: '_test_automation_job',
            name: 'Test automation',
            type: 'memory_event',
            schedule: 'manual',
            task: 'Test automation recorded a memory event.',
            approved: true
        });
        assert.strictEqual(job.id, '_test_automation_job', 'automation job should be saved');
        assert.strictEqual(automations.parseSchedule('30m').minutes, 30, 'compact minute duration should parse');
        assert.strictEqual(automations.parseSchedule('every 2h').minutes, 120, 'compact every duration should parse');
        assert.strictEqual(automations.parseSchedule('0 9 * * *').type, 'cron', '5-field cron should parse');
        assert(automations.nextCronRunAt('*/5 * * * *'), 'cron schedule should produce a next run timestamp');
        const run = await automations.runAutomationJob('_test_automation_job', { approved: true });
        assert(run.run.status === 'completed', 'manual automation should run');
        assert(automations.deleteAutomationJob('_test_automation_job'), 'automation job should be deleted');
    } finally {
        writeAugustCoreMemory(memoryBeforeAutomation);
        if (automationFileExisted) fs.writeFileSync(automations.AUTOMATION_FILE, automationBefore);
        else if (fs.existsSync(automations.AUTOMATION_FILE)) fs.unlinkSync(automations.AUTOMATION_FILE);
    }

    const targets = governance.searchGovernanceTargets('sqlite memory');
    assert(Array.isArray(targets.actions), 'governance search should expose supported actions');

    sqliteStore.deleteMemory('_test_sqlite_memory');

    console.log('SUCCESS orchestration-stack');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
