const assert = require('assert');
const { renderSkillCatalog, renderSkillsForSystem, loadSkillInstructions, saveSkill, deleteSkill, invalidateCache } = require('../src/utils/skills');
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

// Test catalog rendering
const catalog = renderSkillCatalog(skills);
assert(catalog.includes('&lt;review&gt;'), 'trigger should be XML escaped');
assert(catalog.includes('&amp;'), 'description should be XML escaped');
assert(catalog.includes('repo_review'), 'skill name should be present');

// renderSkillsForSystem should produce the same catalog
assert.strictEqual(renderSkillsForSystem(skills), catalog, 'renderSkillsForSystem should match renderSkillCatalog');

// Test loading instructions
const instructions = loadSkillInstructions('repo_review');
assert.strictEqual(instructions, null, 'loadSkillInstructions should return null for name not found (no SKILL.md on disk)');

// Test with disabled skill
const disabledSkills = [
    {
        name: 'disabled_test',
        enabled: false,
        description: 'Should not appear.',
        instructions: 'Hidden instructions.'
    }
];
const disabledCatalog = renderSkillCatalog(disabledSkills);
assert(disabledCatalog.includes('disabled_test'), 'disabled skills still appear in catalog (filtered by caller)');

const fullSkills = [...skills, ...disabledSkills];
assert(renderSkillCatalog(fullSkills).includes('disabled_test'), 'all skills appear in catalog when passed explicitly');

// Test system prompt integration with skill catalog
const prompt = buildSystemPromptText('Keep the client prompt.', {
    model: 'minimax-m2.7',
    targetUrl: 'https://api.minimax.io/anthropic/v1/messages',
    memory: {
        user_profile: '- User likes direct critiques.',
        global_context: '- User works on claudish-proxy.'
    },
    skills
});

assert(prompt.includes('<skill_catalog source="config.customSkills">'), 'skill catalog wrapper missing');
assert(prompt.includes('<client_system_prompt>'), 'client system prompt should remain included');
assert(prompt.includes('Keep the client prompt.'), 'client prompt content missing');
assert(prompt.includes('august__load_skill'), 'load skill instruction should be present');

console.log('SUCCESS skills');
