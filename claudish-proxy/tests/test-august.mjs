import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:8085';
const GATEWAY_KEY = process.env.GATEWAY_KEY || 'august-core-key';

const results = [];
let passedCount = 0;
let failedCount = 0;

async function runTest(name, fn) {
    const start = Date.now();
    try {
        await fn();
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        results.push({ name, passed: true, elapsed });
        passedCount++;
        console.log(`  \x1b[32m\u2713\x1b[0m ${name} (${elapsed}s)`);
    } catch (e) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        results.push({ name, passed: false, elapsed, error: e.message });
        failedCount++;
        console.log(`  \x1b[31m\u2717\x1b[0m ${name} (${elapsed}s)`);
        console.log(`    \x1b[31m${e.message.split('\n')[0]}\x1b[0m`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label}: expected "${expected}", got "${actual}"`);
    }
}

function assertIncludes(haystack, needle, label) {
    if (!String(haystack).includes(needle)) {
        throw new Error(`${label}: expected to include "${needle}"`);
    }
}

// ── Proxy helpers ──

async function proxyGet(path) {
    const res = await fetch(`${PROXY_URL}${path}`);
    return { status: res.status, body: await res.text() };
}

async function proxyPost(path, body, extraHeaders = {}) {
    const res = await fetch(`${PROXY_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.text() };
}

// ═══════════════════════════════════════════════════════════════
// TEST GROUPS
// ═══════════════════════════════════════════════════════════════

// ── Regression Tests ──

async function testRegression() {
    console.log('\n\x1b[36mREGRESSION TESTS\x1b[0m');

    await runTest('R1 Proxy serves UI', async () => {
        const { status, body } = await proxyGet('/');
        assert(status === 200, `Expected 200, got ${status}`);
        assertIncludes(body, 'Claudish Proxy', 'UI should contain title');
    });

    await runTest('R2 Config endpoint works', async () => {
        const { status, body } = await proxyGet('/ui/config/safe');
        assert(status === 200, `Expected 200, got ${status}`);
        const data = JSON.parse(body);
        assert(data.claude, 'Config should have claude profile');
    });

    await runTest('R3 Security gateway blocks bad key (or bypasses localhost)', async () => {
        const { status, body } = await proxyPost('/v1/messages', { model: 'test', messages: [] },
            { 'Authorization': 'Bearer bad-key' }
        );
        // Localhost connections bypass the security gateway (expected behavior)
        if (status === 401) {
            const data = JSON.parse(body);
            assert(data.error, 'Should have error field');
        } else {
            assert(status === 200 || status === 400, `Unexpected status: ${status}`);
        }
    });

    await runTest('R4 Fake model list', async () => {
        const { status, body } = await proxyGet('/v1/models');
        assert(status === 200, `Expected 200, got ${status}`);
        const data = JSON.parse(body);
        assert(data.data, 'Should have data array');
        assert(data.data.some(m => m.id === 'claude-opus-4-6'), 'Should include claude-opus-4-6');
    });

    await runTest('R5 Web search endpoint', async () => {
        const { status } = await proxyGet('/search?q=test');
        assert(status >= 200 && status < 500, `Expected 2xx/4xx, got ${status}`);
    });

    await runTest('R6 Web fetch endpoint', async () => {
        const { status, body } = await proxyGet('/fetch?url=https://example.com');
        assert(status === 200, `Expected 200, got ${status}`);
        const data = JSON.parse(body);
        assert(data.body || data.content, 'Should have body/content');
    });

    await runTest('R7 Activity stream', async () => {
        const { status, body } = await proxyGet('/ui/activity');
        assert(status === 200, `Expected 200, got ${status}`);
        const data = JSON.parse(body);
        assert(Array.isArray(data), 'Should be array');
    });

    await runTest('R8 MCP status', async () => {
        const { status, body } = await proxyGet('/ui/mcp');
        assert(status === 200, `Expected 200, got ${status}`);
        const data = JSON.parse(body);
        assert(data.servers || data.status, 'Should have servers or status');
    });

    await runTest('R9 August memory read', async () => {
        const { status, body } = await proxyGet('/ui/memory');
        assert(status === 200, `Expected 200, got ${status}`);
        const data = JSON.parse(body);
        assert(data, 'Should return memory object');
    });

    await runTest('R10 Test endpoint works', async () => {
        const { status } = await proxyPost('/ui/test', {
            profile: 'claude',
            model: 'test-model',
            targetUrl: 'https://api.minimax.io/anthropic/v1/messages',
            apiKey: 'test'
        });
        assert(status === 200, `Expected 200, got ${status}`);
    });
}

// ── Semantic Memory Tests ──

async function testSemanticMemory() {
    console.log('\n\x1b[36mSEMANTIC MEMORY TESTS\x1b[0m');

    const sm = require('../src/utils/semantic-memory.js');

    await runTest('S1 setFact stores a fact', async () => {
        const fact = sm.setFact('_test_color', 'Sir prefers blue', 'user_preference', null, 'test-script');
        assert(fact.key === '_test_color', 'Should return fact with correct key');
        assert(fact.value === 'Sir prefers blue', 'Should return fact with correct value');
    });

    await runTest('S2 getFact retrieves by key', async () => {
        const fact = sm.getFact('_test_color');
        assert(fact !== null, 'Should find fact');
        assert(fact.value === 'Sir prefers blue', 'Should have correct value');
    });

    await runTest('S3 searchFacts finds facts', async () => {
        const results = sm.searchFacts('blue');
        assert(results.length >= 1, 'Should find at least one fact');
        assert(results.some(f => f.key === '_test_color'), 'Should find test fact');
    });

    await runTest('S4 deleteFact removes fact', async () => {
        sm.setFact('_test_delete', 'to delete', 'user_preference');
        const deleted = sm.deleteFact('_test_delete');
        assert(deleted === true, 'Should return true');
        const fact = sm.getFact('_test_delete');
        assert(fact === null, 'Should be gone after delete');
    });

    await runTest('S5 TTL expiry works', async () => {
        sm.setFact('_test_ttl', 'will expire', 'session_temp', 0);
        const fact = sm.getFact('_test_ttl');
        assert(fact === null, 'Should have expired');
    });

    await runTest('S6 Category filtering', async () => {
        sm.setFact('_test_cat1', 'cat test a', 'user_detail');
        sm.setFact('_test_cat2', 'cat test b', 'workflow_rule');
        const prefs = sm.getFactsByCategory('user_detail');
        assert(prefs.some(f => f.key === '_test_cat1'), 'Should find user_detail fact');
        const workflows = sm.getFactsByCategory('workflow_rule');
        assert(workflows.some(f => f.key === '_test_cat2'), 'Should find workflow_rule fact');
    });

    await runTest('S7 Source tagging', async () => {
        sm.setFact('_test_source', 'source test', 'user_preference', null, 'claude-code');
        const fact = sm.getFact('_test_source');
        assert(fact.source === 'claude-code', `Expected source 'claude-code', got '${fact.source}'`);
    });

    await runTest('S8 getAllFacts returns only non-expired', async () => {
        const all = sm.getAllFacts();
        assert(Array.isArray(all), 'Should return array');
        const expired = all.filter(f => f.ttl && new Date(f.ttl) < new Date());
        assert(expired.length === 0, 'Should have no expired facts');
    });

    await runTest('S9 getFactsBySource filters correctly', async () => {
        sm.setFact('_test_src2', 'source test 2', 'user_preference', null, 'hermes');
        const fromHermes = sm.getFactsBySource('hermes');
        assert(fromHermes.some(f => f.key === '_test_src2'), 'Should find hermes fact');
    });

    // Cleanup test facts
    sm.deleteFact('_test_color');
    sm.deleteFact('_test_cat1');
    sm.deleteFact('_test_cat2');
    sm.deleteFact('_test_source');
    sm.deleteFact('_test_src2');
}

// ── Client Identity Tests ──

async function testClientIdentity() {
    console.log('\n\x1b[36mCLIENT IDENTITY TESTS\x1b[0m');

    const ci = require('../src/utils/client-identity.js');

    await runTest('C1 detect claude-code by UA', async () => {
        const req = { headers: { 'user-agent': 'claude-code/v1.0' } };
        assertEqual(ci.identifyClient(req), 'claude-code', 'claude-code UA');
    });

    await runTest('C2 detect claude-desktop by UA', async () => {
        const req = { headers: { 'user-agent': 'Claude-Desktop-3p/1.0' } };
        assertEqual(ci.identifyClient(req), 'claude-desktop', 'claude-desktop UA');
    });

    await runTest('C3 detect hermes by x-source', async () => {
        const req = { headers: { 'x-source': 'hermes', 'user-agent': 'SomeAgent/1.0' } };
        assertEqual(ci.identifyClient(req), 'hermes', 'hermes x-source');
    });

    await runTest('C4 detect opencode by UA', async () => {
        const req = { headers: { 'user-agent': 'opencode-cli/1.0' } };
        assertEqual(ci.identifyClient(req), 'opencode', 'opencode UA');
    });

    await runTest('C5 detect openwhispr by UA', async () => {
        const req = { headers: { 'user-agent': 'openwhispr/2.0' } };
        assertEqual(ci.identifyClient(req), 'openwhispr', 'openwhispr UA');
    });

    await runTest('C6 detect unknown for empty', async () => {
        const req = { headers: {} };
        assertEqual(ci.identifyClient(req), 'unknown', 'empty headers');
    });

    await runTest('C7 detect unknown for null', async () => {
        assertEqual(ci.identifyClient(null), 'unknown', 'null req');
    });

    await runTest('C8 getDisplayName returns human name', async () => {
        assertEqual(ci.getDisplayName('claude-code'), 'Claude Code', 'claude-code name');
        assertEqual(ci.getDisplayName('hermes'), 'Hermes Agent', 'hermes name');
        assertEqual(ci.getDisplayName('unknown'), 'Unknown Client', 'unknown name');
    });
}

// ── Personality Tests ──

async function testPersonality() {
    console.log('\n\x1b[36mPERSONALITY TESTS\x1b[0m');

    await runTest('P1 System prompt contains AUGUST_PERSONALITY', async () => {
        const cb = require('../src/utils/context-builder.js');
        const details = cb.buildSystemPromptDetails(null, {
            model: 'test-model',
            targetUrl: 'https://api.minimax.io/anthropic/v1/messages',
            clientId: 'claude-code'
        });
        assertIncludes(details.prompt, 'You are AUGUST', 'Should contain AUGUST personality');
        assertIncludes(details.prompt, 'Sir', 'Should address as Sir');
    });

    await runTest('P2 Context builder accepts clientId', async () => {
        const cb = require('../src/utils/context-builder.js');
        const details = cb.buildSystemPromptDetails(null, {
            model: 'test-model',
            targetUrl: 'https://api.minimax.io/anthropic/v1/messages',
            clientId: 'hermes'
        });
        assertIncludes(details.prompt, 'Hermes Agent', 'Should inject client name');
    });

    await runTest('P3 Mid-session reminder is AUGUST-specific', async () => {
        const anthropic = require('../src/adapters/anthropic.js');
        assert(anthropic.AUGUST_REMINDER, 'AUGUST_REMINDER should be exported');
        assertIncludes(anthropic.AUGUST_REMINDER.content, '[AUGUST]', 'Should have [AUGUST] tag');
        assertIncludes(anthropic.AUGUST_REMINDER.content, 'Sir', 'Should address as Sir');
    });

    await runTest('P4 Reminder interval set to 8', async () => {
        const anthropic = require('../src/adapters/anthropic.js');
        // Verify shouldInjectReminderMessage uses % 8 by testing the logic
        const source = anthropic.shouldInjectReminderMessage?.toString() || '';
        assertIncludes(source, '% 8', 'Reminder should fire every 8 turns (was 10)');
    });
}

// ── Specialist Router Tests ──

async function testSpecialistRouter() {
    console.log('\n\x1b[36mSPECIALIST ROUTER TESTS\x1b[0m');

    await runTest('T1 august__call_specialist tool defined', async () => {
        const at = require('../src/utils/august-tools.js');
        const tools = at.getAugustToolDefinitions();
        const tool = tools.find(t => t.function?.name === 'august__call_specialist');
        assert(tool, 'august__call_specialist should be defined');
        assert(tool.function.parameters.properties.specialty, 'Should have specialty parameter');
    });

    await runTest('T2 Specialist endpoints in config', async () => {
        const { getConfig } = require('../src/utils/config.js');
        const config = getConfig();
        assert(config.specialistEndpoints, 'Should have specialistEndpoints');
        assert(config.specialistEndpoints.coding, 'Should have coding endpoint');
        assert(config.specialistEndpoints.research, 'Should have research endpoint');
    });
}

// ── Supermemory Tests ──

async function testSupermemory() {
    console.log('\n\x1b[36mSUPERMEMORY TESTS\x1b[0m');

    await runTest('M1 august__supermemory tool defined', async () => {
        const at = require('../src/utils/august-tools.js');
        const tools = at.getAugustToolDefinitions();
        const tool = tools.find(t => t.function?.name === 'august__supermemory');
        assert(tool, 'august__supermemory should be defined');
        const props = tool.function.parameters.properties;
        assert(props.action, 'Should have action parameter');
    });
}

// ── URL MCP Tests ──

async function testUrlMcp() {
    console.log('\n\x1b[36mURL MCP TESTS\x1b[0m');

    const mr = require('../src/utils/mcp-registry.js');

    await runTest('U1 normalizeMcpServer accepts url', async () => {
        const server = mr.normalizeMcpServer({
            name: 'test-url',
            url: 'https://example.com/mcp',
            headers: { 'Authorization': 'Bearer test' }
        });
        assert(server.url === 'https://example.com/mcp', 'Should preserve url');
        assert(server.headers.Authorization === 'Bearer test', 'Should preserve headers');
    });

    await runTest('U2 normalizeMcpServer accepts command', async () => {
        const server = mr.normalizeMcpServer({
            name: 'test-cmd',
            command: 'npx',
            args: ['-y', 'some-package']
        });
        assert(server.command === 'npx', 'Should preserve command');
    });

    await runTest('U3 normalizeMcpServer rejects neither url nor command', async () => {
        let threw = false;
        try {
            mr.normalizeMcpServer({ name: 'bad' });
        } catch (e) {
            threw = true;
            assertIncludes(e.message, 'command', 'Error should mention command');
        }
        assert(threw, 'Should throw when neither url nor command provided');
    });

    await runTest('U4 toHeadersObject converts headers', async () => {
        const result = mr.toHeadersObject({
            'Authorization': 'Bearer xyz',
            'X-Custom': 'value'
        });
        assert(result.Authorization === 'Bearer xyz', 'Should preserve auth header');
        assert(result['X-Custom'] === 'value', 'Should preserve custom header');
    });

    await runTest('U5 toHeadersObject empty for falsy', async () => {
        assertEqual(Object.keys(mr.toHeadersObject(null)).length, 0, 'null returns empty');
        assertEqual(Object.keys(mr.toHeadersObject(undefined)).length, 0, 'undefined returns empty');
    });
}

// ── August Tools Registration Tests ──

async function testAugustTools() {
    console.log('\n\x1b[36mAUGUST TOOLS REGISTRATION\x1b[0m');

    await runTest('A1 All AUGUST tools are registered', async () => {
        const at = require('../src/utils/august-tools.js');
        const tools = at.getAugustToolDefinitions();
        const names = tools.map(t => t.function?.name).filter(Boolean);

        const expected = [
            'august__bash',
            'august__read_file',
            'august__write_file',
            'august__core_memory_append',
            'august__core_memory_replace',
            'august__remember_project',
            'august__remember_integration',
            'august__remember_event',
            'august__remember_checkpoint',
            'august__search_past_conversations',
            'august__spawn_background_task',
            'august__remember',
            'august__forget',
            'august__recall',
            'august__list_facts',
            'august__call_specialist',
            'august__supermemory',
        ];

        for (const name of expected) {
            assert(names.includes(name), `Tool '${name}' should be registered`);
        }
    });

    await runTest('A2 Tool count is correct', async () => {
        const at = require('../src/utils/august-tools.js');
        const tools = at.getAugustToolDefinitions();
        assert(tools.length >= 17, `Expected 17+ tools, got ${tools.length}`);
    });
}

// ── Context Builder Integration Tests ──

async function testContextBuilder() {
    console.log('\n\x1b[36mCONTEXT BUILDER INTEGRATION\x1b[0m');

    await runTest('X1 Client identity can be injected', async () => {
        const cb = require('../src/utils/context-builder.js');
        const details = cb.buildSystemPromptDetails(null, {
            model: 'test-model',
            targetUrl: 'https://api.minimax.io/anthropic/v1/messages',
            clientId: 'opencode'
        });
        assertIncludes(details.prompt, 'OpenCode', 'Should contain client display name');
    });

    await runTest('X2 Semantic facts can be injected', async () => {
        const sm = require('../src/utils/semantic-memory.js');
        sm.setFact('_test_ctx_fact', 'integration test', 'user_preference', null, 'test');
        const cb = require('../src/utils/context-builder.js');
        const details = cb.buildSystemPromptDetails(null, {
            model: 'test-model',
            targetUrl: 'https://api.minimax.io/anthropic/v1/messages',
        });
        assertIncludes(details.prompt, 'integration test', 'Should contain fact value');
        sm.deleteFact('_test_ctx_fact');
    });
}

// ═══════════════════════════════════════════════════════════════
// MAIN RUNNER
// ═══════════════════════════════════════════════════════════════

async function runAll() {
    console.log('\n\x1b[1;36m═══════════════════════════════════════');
    console.log('  AUGUST Brain — Test Suite');
    console.log('═══════════════════════════════════════\x1b[0m');
    console.log(`Proxy URL: ${PROXY_URL}`);

    const testGroups = [
        testRegression,
        testSemanticMemory,
        testClientIdentity,
        testPersonality,
        testSpecialistRouter,
        testSupermemory,
        testUrlMcp,
        testAugustTools,
        testContextBuilder,
    ];

    for (const group of testGroups) {
        try {
            await group();
        } catch (e) {
            console.log(`\n  \x1b[31mGroup error: ${e.message}\x1b[0m`);
        }
    }

    console.log('\n\x1b[1;36m═══════════════════════════════════════');
    console.log(`  Results: ${passedCount} passed, ${failedCount} failed`);
    console.log(`  Duration: ${((Date.now() - globalStart) / 1000).toFixed(1)}s`);
    console.log('═══════════════════════════════════════\x1b[0m\n');

    if (failedCount > 0) {
        console.log('\x1b[33mFailed tests:\x1b[0m');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`  \x1b[31m✗ ${r.name}\x1b[0m`);
            console.log(`    ${r.error}`);
        });
        console.log();
    }

    return failedCount === 0;
}

const globalStart = Date.now();

runAll().then(allPassed => {
    process.exit(allPassed ? 0 : 1);
}).catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
