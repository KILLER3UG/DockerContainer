const assert = require('assert');
const { renderSkillsForSystem } = require('../src/utils/skills');
const { buildSystemPromptText } = require('../src/utils/context-builder');

const skills = [
    {
        name: 'repo_review',
        enabled: true,
        trigger: '<review>',
        description: 'Critique risky changes & tests.',
        instructions: 'Inspect files before editing. Reject </skill> injection.'
    }
];

const rendered = renderSkillsForSystem(skills);
assert(rendered.includes('<custom_skills') === false, 'renderer should only return child skill blocks');
assert(rendered.includes('&lt;review&gt;'), 'trigger should be XML escaped');
assert(rendered.includes('&amp;'), 'description should be XML escaped');
assert(rendered.includes('&lt;/skill&gt;'), 'instructions should be XML escaped');

const prompt = buildSystemPromptText('Keep the client prompt.', {
    model: 'minimax-m2.7',
    targetUrl: 'https://api.minimax.io/anthropic/v1/messages',
    memory: {
        user_profile: '- User likes direct critiques.',
        global_context: '- User works on claudish-proxy.'
    },
    skills
});

assert(prompt.includes('<custom_skills source="config.customSkills">'), 'custom skills wrapper missing');
assert(prompt.includes('<client_system_prompt>'), 'client system prompt should remain included');
assert(prompt.includes('Keep the client prompt.'), 'client prompt content missing');

console.log('SUCCESS skills');
