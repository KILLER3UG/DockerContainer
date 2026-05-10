const { getConfig, saveConfig } = require('./config');

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function escapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function normalizeSkill(raw) {
    const name = String(raw?.name || '').trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
        throw new Error('Skill name must be 1-64 characters and use only letters, numbers, underscores, or dashes.');
    }
    const description = String(raw?.description || '').trim();
    const trigger = String(raw?.trigger || '').trim();
    const instructions = String(raw?.instructions || raw?.content || '').trim();
    if (!instructions) throw new Error('Skill instructions are required.');

    return {
        name,
        enabled: raw.enabled !== false,
        description,
        trigger,
        instructions,
        updatedAt: raw.updatedAt || new Date().toISOString()
    };
}

function getSkills() {
    const config = getConfig();
    return Array.isArray(config.customSkills)
        ? config.customSkills.map(skill => normalizeSkill(skill))
        : [];
}

function getEnabledSkills() {
    return getSkills().filter(skill => skill.enabled);
}

function saveSkill(data) {
    const normalized = normalizeSkill(data);
    const config = getConfig();
    const current = Array.isArray(config.customSkills) ? config.customSkills : [];
    const existingIndex = current.findIndex(skill => skill?.name === normalized.name);
    if (existingIndex >= 0) current[existingIndex] = normalized;
    else current.push(normalized);
    config.customSkills = current;
    saveConfig(config);
    return normalized;
}

function deleteSkill(name) {
    const normalizedName = String(name || '').trim();
    if (!SKILL_NAME_PATTERN.test(normalizedName)) throw new Error('Invalid skill name.');
    const config = getConfig();
    const current = Array.isArray(config.customSkills) ? config.customSkills : [];
    const before = current.length;
    config.customSkills = current.filter(skill => skill?.name !== normalizedName);
    saveConfig(config);
    return { deleted: config.customSkills.length < before };
}

function renderSkillsForSystem(skills = getEnabledSkills()) {
    if (!skills || skills.length === 0) return '';
    return skills.map(skill => {
        const parts = [
            `<skill name="${escapeXml(skill.name)}" enabled="${skill.enabled ? 'true' : 'false'}">`
        ];
        if (skill.trigger) parts.push(`<trigger>${escapeXml(skill.trigger)}</trigger>`);
        if (skill.description) parts.push(`<description>${escapeXml(skill.description)}</description>`);
        parts.push(`<instructions>\n${escapeXml(skill.instructions)}\n</instructions>`);
        parts.push('</skill>');
        return parts.join('\n');
    }).join('\n\n');
}

module.exports = {
    deleteSkill,
    getEnabledSkills,
    getSkills,
    normalizeSkill,
    renderSkillsForSystem,
    saveSkill,
    escapeXml
};
