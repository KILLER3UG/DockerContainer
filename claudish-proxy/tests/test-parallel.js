const http = require('http');

const PROXY_URL = 'http://localhost:8085';

// ── Helper: POST JSON and return parsed response ──
function post(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(PROXY_URL + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer sk-test',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) });
                } catch {
                    resolve({ status: res.statusCode, headers: res.headers, body: raw });
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ── Helper: POST to Responses API and parse SSE ──
function postResponses(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(PROXY_URL + '/v1/responses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer sk-test',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                const events = raw
                    .split('\n')
                    .filter(l => l.startsWith('data: '))
                    .map(l => {
                        const json = l.slice(6);
                        if (json === '[DONE]') return { type: 'done' };
                        try { return JSON.parse(json); } catch { return { type: 'parse_error', raw: json }; }
                    });
                resolve({ status: res.statusCode, events });
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ── Test: Claude (Anthropic /v1/messages) multi-turn tool flow ──
async function testClaudeToolFlow() {
    const startTime = Date.now();
    console.log('\n========== CLAUDE TOOL FLOW TEST ==========\n');

    const tools = [
        {
            name: 'list_files',
            description: 'List files in a directory',
            input_schema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path']
            }
        },
        {
            name: 'read_file',
            description: 'Read a file',
            input_schema: {
                type: 'object',
                properties: { file_path: { type: 'string' } },
                required: ['file_path']
            }
        }
    ];

    // Turn 1: Ask to explore project
    console.log('--- Turn 1: Initial request ---');
    const turn1 = await post('/v1/messages', {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0.7,
        tools,
        messages: [{ role: 'user', content: 'Explore this project. List the root directory, then read package.json, then read README.md.' }]
    });
    console.log('Status:', turn1.status);
    const msg1 = turn1.body;
    console.log('Stop reason:', msg1.stop_reason);
    console.log('Content blocks:', msg1.content.length);
    msg1.content.forEach((c, i) => {
        console.log(`  [${i}] type=${c.type}${c.type === 'tool_use' ? ` id=${c.id} name=${c.name}` : ''}${c.text ? ` text="${c.text.substring(0, 80)}..."` : ''}`);
    });

    if (msg1.stop_reason !== 'tool_use') {
        console.log('⚠ Expected tool_use, got', msg1.stop_reason);
        return { passed: false, error: 'Turn 1 did not return tool_use' };
    }

    // Verify tool IDs are in correct format
    const toolUses = msg1.content.filter(c => c.type === 'tool_use');
    console.log(`Found ${toolUses.length} tool call(s)`);
    for (const tu of toolUses) {
        if (!tu.id || !tu.id.startsWith('toolu_')) {
            console.log('⚠ Invalid tool_use ID format:', tu.id);
            return { passed: false, error: 'Invalid tool_use ID format' };
        }
    }

    // Turn 2: Send tool results
    console.log('\n--- Turn 2: Tool results ---');
    const toolResults = toolUses.map(tu => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: tu.name === 'list_files'
            ? 'bridge.js\nconfig.json\npackage.json\nREADME.md\nDockerfile'
            : tu.input?.file_path?.includes('package')
                ? '{"name": "test-project", "version": "1.0.0"}'
                : '# Test Project\nThis is a test.'
    }));

    const turn2 = await post('/v1/messages', {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0.7,
        tools,
        messages: [
            { role: 'user', content: 'Explore this project. List the root directory, then read package.json, then read README.md.' },
            { role: 'assistant', content: msg1.content },
            { role: 'user', content: toolResults }
        ]
    });
    console.log('Status:', turn2.status);
    const msg2 = turn2.body;
    console.log('Stop reason:', msg2.stop_reason);
    console.log('Content blocks:', msg2.content.length);
    msg2.content.forEach((c, i) => {
        console.log(`  [${i}] type=${c.type}${c.type === 'tool_use' ? ` id=${c.id} name=${c.name}` : ''}${c.text ? ` text="${c.text.substring(0, 80)}..."` : ''}`);
    });

    // Validate turn 2 ID round-trip: the tool_use IDs from turn 1 must be decodable back
    // This proves the deterministic encoding works across turns
    if (msg2.stop_reason === 'tool_use') {
        const toolUses2 = msg2.content.filter(c => c.type === 'tool_use');
        console.log('\n--- Turn 3: Second tool results ---');
        const toolResults2 = toolUses2.map(tu => ({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'Additional file content here.'
        }));

        const turn3 = await post('/v1/messages', {
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            temperature: 0.7,
            tools,
            messages: [
                { role: 'user', content: 'Explore this project. List the root directory, then read package.json, then read README.md.' },
                { role: 'assistant', content: msg1.content },
                { role: 'user', content: toolResults },
                { role: 'assistant', content: msg2.content },
                { role: 'user', content: toolResults2 }
            ]
        });
        console.log('Status:', turn3.status);
        const msg3 = turn3.body;
        console.log('Stop reason:', msg3.stop_reason);
        console.log('Content blocks:', msg3.content.length);
        msg3.content.forEach((c, i) => {
            console.log(`  [${i}] type=${c.type}${c.text ? ` text="${c.text.substring(0, 80)}..."` : ''}`);
        });

        if (!msg3.content.some(c => c.type === 'text' && c.text.length > 10)) {
            console.log('⚠ Turn 3 response text seems empty or too short');
            return { passed: false, error: 'Turn 3 text too short' };
        }
    } else {
        // If turn 2 ends with end_turn, validate it has meaningful text
        if (!msg2.content.some(c => c.type === 'text' && c.text.length > 10)) {
            console.log('⚠ Turn 2 response text seems empty or too short');
            return { passed: false, error: 'Turn 2 text too short' };
        }
    }

    const elapsed = Date.now() - startTime;
    console.log(`\n✅ Claude tool flow test complete (${elapsed}ms)\n`);
    return { passed: true, elapsed };
}

// ── Test: Codex (/v1/responses) multi-turn tool flow ──
async function testCodexToolFlow() {
    const startTime = Date.now();
    console.log('\n========== CODEX TOOL FLOW TEST ==========\n');

    const tools = [
        {
            type: 'function',
            function: {
                name: 'list_files',
                description: 'List files in a directory',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_file',
                description: 'Read a file',
                parameters: {
                    type: 'object',
                    properties: { file_path: { type: 'string' } },
                    required: ['file_path']
                }
            }
        }
    ];

    // Turn 1: Ask to explore project
    console.log('--- Turn 1: Initial request ---');
    const turn1 = await postResponses({
        model: 'gpt-5.4',
        instructions: 'You are a helpful coding assistant.',
        input: [{ role: 'user', content: 'Explore this project. List the root directory, then read package.json.' }],
        tools,
        tool_choice: 'auto',
        stream: true
    });
    console.log('Status:', turn1.status);
    console.log('Events:', turn1.events.length);

    const completedEvent1 = turn1.events.find(e => e.type === 'response.completed');
    if (!completedEvent1) {
        console.log('⚠ No response.completed event found');
        console.log('Event types:', turn1.events.map(e => e.type));
        return { passed: false, error: 'No response.completed in turn 1' };
    }

    const output1 = completedEvent1.response.output;
    console.log('Output items:', output1.length);
    output1.forEach((item, i) => {
        console.log(`  [${i}] type=${item.type}${item.type === 'function_call' ? ` name=${item.name}` : ''}${item.type === 'message' ? ` text="${item.content?.[0]?.text?.substring(0, 80)}..."` : ''}`);
    });

    const funcCalls1 = output1.filter(item => item.type === 'function_call');
    if (funcCalls1.length === 0) {
        console.log('⚠ Expected function_call(s), got none');
        return { passed: false, error: 'No function_calls in turn 1' };
    }

    // Turn 2: Send tool results in Responses API format
    console.log('\n--- Turn 2: Tool results ---');
    const input2 = [
        { role: 'user', content: 'Explore this project. List the root directory, then read package.json.' },
        ...funcCalls1.map(fc => ({
            type: 'function_call',
            call_id: fc.call_id,
            name: fc.name,
            arguments: fc.arguments
        })),
        ...funcCalls1.map(fc => ({
            type: 'function_call_output',
            call_id: fc.call_id,
            output: fc.name === 'list_files'
                ? 'bridge.js\nconfig.json\npackage.json\nREADME.md'
                : '{"name": "test-project"}'
        }))
    ];

    const turn2 = await postResponses({
        model: 'gpt-5.4',
        instructions: 'You are a helpful coding assistant.',
        input: input2,
        tools,
        tool_choice: 'auto',
        stream: true
    });
    console.log('Status:', turn2.status);
    console.log('Events:', turn2.events.length);

    const completedEvent2 = turn2.events.find(e => e.type === 'response.completed');
    if (!completedEvent2) {
        console.log('⚠ No response.completed event found');
        console.log('Event types:', turn2.events.map(e => e.type));
        return { passed: false, error: 'No response.completed in turn 2' };
    }

    const output2 = completedEvent2.response.output;
    console.log('Output items:', output2.length);
    output2.forEach((item, i) => {
        console.log(`  [${i}] type=${item.type}${item.type === 'function_call' ? ` name=${item.name}` : ''}${item.type === 'message' ? ` text="${item.content?.[0]?.text?.substring(0, 80)}..."` : ''}`);
    });

    if (output2.some(item => item.type === 'function_call')) {
        // Turn 3: Another round
        console.log('\n--- Turn 3: Second tool results ---');
        const funcCalls2 = output2.filter(item => item.type === 'function_call');
        const input3 = [
            ...input2,
            ...funcCalls2.map(fc => ({
                type: 'function_call',
                call_id: fc.call_id,
                name: fc.name,
                arguments: fc.arguments
            })),
            ...funcCalls2.map(fc => ({
                type: 'function_call_output',
                call_id: fc.call_id,
                output: 'More file content.'
            }))
        ];

        const turn3 = await postResponses({
            model: 'gpt-5.4',
            instructions: 'You are a helpful coding assistant.',
            input: input3,
            tools,
            tool_choice: 'auto',
            stream: true
        });
        console.log('Status:', turn3.status);
        const completedEvent3 = turn3.events.find(e => e.type === 'response.completed');
        if (completedEvent3) {
            const output3 = completedEvent3.response.output;
            console.log('Output items:', output3.length);
            output3.forEach((item, i) => {
                console.log(`  [${i}] type=${item.type}${item.type === 'message' ? ` text="${item.content?.[0]?.text?.substring(0, 80)}..."` : ''}`);
            });
            const msgItem = output3.find(item => item.type === 'message');
            if (!msgItem || !msgItem.content?.[0]?.text || msgItem.content[0].text.length < 10) {
                console.log('⚠ Turn 3 message text seems empty or too short');
                return { passed: false, error: 'Turn 3 text too short' };
            }
        } else {
            console.log('⚠ No response.completed in turn 3');
            return { passed: false, error: 'No response.completed in turn 3' };
        }
    } else {
        const msgItem = output2.find(item => item.type === 'message');
        if (!msgItem || !msgItem.content?.[0]?.text || msgItem.content[0].text.length < 10) {
            console.log('⚠ Turn 2 message text seems empty or too short');
            return { passed: false, error: 'Turn 2 text too short' };
        }
    }

    const elapsed = Date.now() - startTime;
    console.log(`\n✅ Codex tool flow test complete (${elapsed}ms)\n`);
    return { passed: true, elapsed };
}

// ── Run both tests IN PARALLEL ──
(async () => {
    console.log('\n🚀 STARTING PARALLEL TESTS\n');
    const overallStart = Date.now();

    try {
        const [claudeResult, codexResult] = await Promise.all([
            testClaudeToolFlow().catch(e => ({ passed: false, error: e.message })),
            testCodexToolFlow().catch(e => ({ passed: false, error: e.message }))
        ]);

        const overallElapsed = Date.now() - overallStart;
        console.log('\n============================================');
        console.log('           PARALLEL TEST RESULTS');
        console.log('============================================');
        console.log(`Claude test: ${claudeResult.passed ? '✅ PASSED' : '❌ FAILED'} ${claudeResult.elapsed ? `(${claudeResult.elapsed}ms)` : ''}`);
        if (!claudeResult.passed) console.log('  Error:', claudeResult.error);
        console.log(`Codex test:  ${codexResult.passed ? '✅ PASSED' : '❌ FAILED'} ${codexResult.elapsed ? `(${codexResult.elapsed}ms)` : ''}`);
        if (!codexResult.passed) console.log('  Error:', codexResult.error);
        console.log(`Total wall time: ${overallElapsed}ms`);
        console.log(`Parallel speedup: ~${Math.round((claudeResult.elapsed || 0 + codexResult.elapsed || 0) / Math.max(overallElapsed, 1))}x`);
        console.log('============================================\n');

        if (!claudeResult.passed || !codexResult.passed) {
            process.exit(1);
        }
    } catch (e) {
        console.error('Unexpected test runner error:', e);
        process.exit(1);
    }
})();
