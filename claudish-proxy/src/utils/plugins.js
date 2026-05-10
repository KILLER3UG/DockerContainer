const { getConfig, saveConfig } = require('./config');
const { escapeXml } = require('./skills');

const PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function normalizeName(value, fallback = 'proxy_plugin') {
    const base = String(value || fallback)
        .trim()
        .replace(/^@/, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return base || fallback;
}

function normalizePlugin(raw = {}) {
    const name = normalizeName(raw.name || raw.id || raw.slug);
    if (!PLUGIN_NAME_PATTERN.test(name)) {
        throw new Error('Plugin name must be 1-64 characters and use only letters, numbers, underscores, or dashes.');
    }
    return {
        name,
        enabled: raw.enabled !== false,
        description: String(raw.description || '').trim(),
        sourceUrl: String(raw.sourceUrl || raw.url || '').trim(),
        skills: Array.isArray(raw.skills) ? raw.skills : [],
        mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
        notes: String(raw.notes || '').trim(),
        updatedAt: raw.updatedAt || new Date().toISOString()
    };
}

function getPlugins() {
    const config = getConfig();
    return Array.isArray(config.customPlugins)
        ? config.customPlugins.map(plugin => normalizePlugin(plugin))
        : [];
}

function getEnabledPlugins() {
    return getPlugins().filter(plugin => plugin.enabled);
}

function savePlugin(data) {
    const normalized = normalizePlugin(data);
    const config = getConfig();
    const current = Array.isArray(config.customPlugins) ? config.customPlugins : [];
    const existingIndex = current.findIndex(plugin => plugin?.name === normalized.name);
    if (existingIndex >= 0) current[existingIndex] = {
        ...normalizePlugin(current[existingIndex]),
        ...normalized,
        updatedAt: new Date().toISOString()
    };
    else current.push(normalized);
    config.customPlugins = current;
    saveConfig(config);
    return normalized;
}

function deletePlugin(name) {
    const normalizedName = normalizeName(name, '');
    if (!PLUGIN_NAME_PATTERN.test(normalizedName)) throw new Error('Invalid plugin name.');
    const config = getConfig();
    const current = Array.isArray(config.customPlugins) ? config.customPlugins : [];
    const before = current.length;
    config.customPlugins = current.filter(plugin => plugin?.name !== normalizedName);
    saveConfig(config);
    return { deleted: config.customPlugins.length < before };
}

function renderPluginsForSystem(plugins = getEnabledPlugins()) {
    if (!plugins || plugins.length === 0) return '';
    return plugins.map(plugin => {
        const parts = [
            `<plugin name="${escapeXml(plugin.name)}" enabled="${plugin.enabled ? 'true' : 'false'}">`
        ];
        if (plugin.description) parts.push(`<description>${escapeXml(plugin.description)}</description>`);
        if (plugin.sourceUrl) parts.push(`<source_url>${escapeXml(plugin.sourceUrl)}</source_url>`);
        if (plugin.mcpServers.length > 0) {
            parts.push('<mcp_servers>');
            plugin.mcpServers.forEach(server => {
                parts.push(`- ${escapeXml(server.name || 'unnamed')} (${escapeXml(server.command || 'unknown command')})`);
            });
            parts.push('</mcp_servers>');
        }
        if (plugin.skills.length > 0) {
            parts.push('<skills>');
            plugin.skills.forEach(skill => {
                parts.push(`- ${escapeXml(skill.name || 'unnamed')}: ${escapeXml(skill.description || skill.trigger || '')}`);
            });
            parts.push('</skills>');
        }
        if (plugin.notes) parts.push(`<notes>${escapeXml(plugin.notes)}</notes>`);
        parts.push('</plugin>');
        return parts.join('\n');
    }).join('\n\n');
}

module.exports = {
    deletePlugin,
    getEnabledPlugins,
    getPlugins,
    normalizeName,
    normalizePlugin,
    renderPluginsForSystem,
    savePlugin
};
