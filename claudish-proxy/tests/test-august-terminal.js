const assert = require('assert');
const {
    BASE_COMMANDS,
    createSseParser,
    parseArgs,
    stripMarkdown,
    summarizeToolResultText,
    summarizeValue,
    wrapText
} = require('../src/august-terminal');

function testParseArgs() {
    const parsed = parseArgs([
        '--provider', 'codex',
        '--agent', 'explore',
        '--theme=slate',
        '--proxy', 'http://127.0.0.1:9999/',
        '--once', '/status',
        '--no-color',
        '--thinking'
    ]);
    assert.strictEqual(parsed.provider, 'codex');
    assert.strictEqual(parsed.agentId, 'explore');
    assert.strictEqual(parsed.theme, 'slate');
    assert.strictEqual(parsed.proxyUrl, 'http://127.0.0.1:9999');
    assert.strictEqual(parsed.once, '/status');
    assert.strictEqual(parsed.color, false);
    assert.strictEqual(parsed.showThinking, true);
}

function testCommandRegistry() {
    const names = new Set(BASE_COMMANDS.map(command => command.name));
    ['help', 'commands', 'plan', 'goal', 'approve', 'build', 'tools', 'skills', 'agents', 'diagnose', 'doctor-local', 'retry', 'copy', 'btw', 'thinking', 'theme', 'tui', 'exit']
        .forEach(name => assert.ok(names.has(name), `missing /${name}`));
    const aliases = new Set(BASE_COMMANDS.flatMap(command => command.aliases || []));
    assert.ok(aliases.has('implement'));
    assert.ok(aliases.has('model'));
    assert.ok(aliases.has('permissions'));
    assert.ok(aliases.has('doctor'));
    assert.ok(aliases.has('quit'));
}

function testSseParser() {
    const events = [];
    const parser = createSseParser((event, data) => events.push({ event, data }));
    parser('event: thinking\n');
    parser('data: {"content":"abc"}\n\n');
    parser('event: text\ndata: {"content":"done"}\n\n');
    assert.deepStrictEqual(events, [
        { event: 'thinking', data: { content: 'abc' } },
        { event: 'text', data: { content: 'done' } }
    ]);
}

function testFormatting() {
    assert.strictEqual(stripMarkdown('## Hello **there** `friend`'), 'Hello there friend');
    assert.ok(wrapText('one two three four five six seven eight nine ten eleven twelve', 30, '  ').includes('\n'));
    assert.strictEqual(summarizeValue({ path: 'C:\\Temp\\file.txt', extra: 'ignored' }), 'C:\\Temp\\file.txt');
    assert.ok(summarizeToolResultText(JSON.stringify({ status: 'ok', path: 'file.txt' })).includes('ok'));
    assert.ok(summarizeToolResultText(JSON.stringify({ blocked: true, message: 'approval required' }), true).includes('approval'));
}

testParseArgs();
testCommandRegistry();
testSseParser();
testFormatting();

console.log('test-august-terminal: ok');
