const assert = require('assert');
const { LlmAdapterBase } = require('../src/adapters/base');

const adapter = new LlmAdapterBase({ profileName: 'test', logPrefix: 'Test' });

const parsed = adapter.parseOpenAIChatSSE([
    'data: {"id":"chatcmpl-test","model":"minimax-m2.7","choices":[{"delta":{"reasoning_content":"think "}}]}',
    'data: {"choices":[{"delta":{"content":"hello "}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_","arguments":"{\\"q\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"\\"docs\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
    'data: [DONE]'
].join('\n'));

assert.strictEqual(parsed.id, 'chatcmpl-test');
assert.strictEqual(parsed.model, 'minimax-m2.7');
assert.strictEqual(parsed.choices[0].message.content, 'hello ');
assert.strictEqual(parsed.choices[0].message.reasoning, 'think ');
assert.strictEqual(parsed.choices[0].finish_reason, 'tool_calls');
assert.strictEqual(parsed.choices[0].message.tool_calls[0].function.name, 'web_search');
assert.strictEqual(parsed.choices[0].message.tool_calls[0].function.arguments, '{"q":"docs"}');
assert.deepStrictEqual(adapter.extractUsageTokens(parsed.usage, 'test'), { inputTokens: 10, outputTokens: 5 });

const prompt = adapter.buildProviderSystemPrompt('Client prompt.', {
    model: 'MiniMax-M2.7',
    memory: {
        user_profile: 'User wants direct verification.',
        global_context: 'Working on claudish-proxy.',
        active_projects: [],
        integrations: {},
        recent_events: [],
        conversation_checkpoints: []
    }
});

assert(prompt.includes('<minimax_m2_7_instructions>'), 'base adapter should share MiniMax prompt wrapping');
assert(prompt.includes('<client_system_prompt>'), 'base adapter should include client system prompt wrapper');
assert(prompt.includes('Client prompt.'), 'base adapter should preserve client system prompt');

console.log('SUCCESS adapter-base');
