const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let cachedConfig = null;
let cachedMtime = 0;
const DEFAULT_CLAUDE_PUBLIC_MODEL = 'claude-opus-4-6';

function looksLikeClaudePublicModel(model) {
    return typeof model === 'string' && model.trim().toLowerCase().startsWith('claude-');
}

function normalizeClaudeProfile(profile) {
    const normalized = { ...(profile || {}) };
    const currentModel = typeof normalized.currentModel === 'string' ? normalized.currentModel.trim() : '';
    const preservedAlias = looksLikeClaudePublicModel(currentModel)
        ? currentModel
        : DEFAULT_CLAUDE_PUBLIC_MODEL;

    if (!looksLikeClaudePublicModel(currentModel) && currentModel) {
        if (normalized._upstreamModel === undefined) {
            normalized._upstreamModel = currentModel;
        }
        normalized.currentModel = preservedAlias;
        return normalized;
    }

    if (!currentModel) {
        normalized.currentModel = preservedAlias;
    }

    return normalized;
}

function getConfig() {
    try {
        const stats = fs.statSync(CONFIG_PATH);
        if (!cachedConfig || stats.mtimeMs > cachedMtime) {
            cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            cachedMtime = stats.mtimeMs;
            console.log('[Config] Reloaded from disk (mtime changed)');
        }
    } catch (e) {
        if (!cachedConfig) throw e;
        console.error('[Config] Failed to reload config, using cache:', e.message);
    }
    return cachedConfig;
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    cachedConfig = config;
    try {
        cachedMtime = fs.statSync(CONFIG_PATH).mtimeMs;
    } catch (e) {
        cachedMtime = Date.now();
    }
}

// Get a profile config (claude or codex).
// Falls back to flat format for backward compatibility.
function getProfile(name) {
    const config = getConfig();
    if (config[name] && typeof config[name] === 'object' && config[name].targetUrl) {
        return name === 'claude' ? normalizeClaudeProfile(config[name]) : config[name];
    }
    // Old flat format fallback
    const profile = {
        targetUrl: config.targetUrl,
        currentModel: config.currentModel,
        apiKey: config.apiKey
    };
    return name === 'claude' ? normalizeClaudeProfile(profile) : profile;
}

// Get a specific field from a profile, with fallback
function getProfileField(name, field, defaultValue) {
    const profile = getProfile(name);
    return profile[field] !== undefined ? profile[field] : defaultValue;
}

// Save a profile config. Migrates from flat format if needed.
function saveProfile(name, profileConfig) {
    const config = getConfig();

    // Migrate from flat format if we see old root-level keys and no profiles
    if (config.targetUrl && !config.claude && !config.codex) {
        const oldConfig = {
            targetUrl: config.targetUrl,
            currentModel: config.currentModel,
            apiKey: config.apiKey
        };
        config.claude = { ...oldConfig };
        config.codex = { ...oldConfig };
        delete config.targetUrl;
        delete config.currentModel;
        delete config.apiKey;
    }

    const previousProfile = config[name] && typeof config[name] === 'object'
        ? (name === 'claude' ? normalizeClaudeProfile(config[name]) : config[name])
        : null;
    const normalizedProfileConfig = name === 'claude'
        ? normalizeClaudeProfile(profileConfig)
        : profileConfig;
    const previousContextModel = name === 'claude'
        ? (previousProfile?._upstreamModel || previousProfile?.currentModel)
        : previousProfile?.currentModel;
    const nextContextModel = name === 'claude'
        ? (normalizedProfileConfig._upstreamModel || normalizedProfileConfig.currentModel)
        : normalizedProfileConfig.currentModel;
    const modelChanged = previousContextModel && previousContextModel !== nextContextModel;

    const preservedInternalFields = {};
    if (previousProfile && typeof previousProfile === 'object') {
        Object.entries(previousProfile).forEach(([key, value]) => {
            if (key.startsWith('_') && normalizedProfileConfig[key] === undefined) {
                preservedInternalFields[key] = value;
            }
        });
    }

    config[name] = { ...normalizedProfileConfig, ...preservedInternalFields };
    if (modelChanged) {
        delete config[name].contextWindow;
        delete config[name].contextModelId;
    } else if (previousProfile?.contextModelId && config[name].contextModelId === undefined) {
        config[name].contextModelId = previousProfile.contextModelId;
    }
    saveConfig(config);
}

function syncClaudePublicAlias(publicAlias) {
    if (!looksLikeClaudePublicModel(publicAlias)) return null;

    const config = getConfig();
    const existingProfile = config.claude && typeof config.claude === 'object'
        ? normalizeClaudeProfile(config.claude)
        : normalizeClaudeProfile({});
    const normalizedAlias = publicAlias.trim();

    if (existingProfile.currentModel === normalizedAlias) {
        return existingProfile;
    }

    config.claude = {
        ...existingProfile,
        currentModel: normalizedAlias
    };
    saveConfig(config);
    return config.claude;
}

// ── Custom Provider Bookmarks ──
function getBookmarks() {
    const config = getConfig();
    return config.bookmarks || [];
}

function saveBookmark(name, baseUrl, apiKey, inputCostPer1M, outputCostPer1M) {
    const config = getConfig();
    if (!config.bookmarks) config.bookmarks = [];
    const existingIndex = config.bookmarks.findIndex(b => b.name === name);
    const bookmark = { name, baseUrl, apiKey, inputCostPer1M: inputCostPer1M || 0, outputCostPer1M: outputCostPer1M || 0 };
    if (existingIndex >= 0) {
        config.bookmarks[existingIndex] = bookmark;
    } else {
        config.bookmarks.push(bookmark);
    }
    saveConfig(config);
    return bookmark;
}

function deleteBookmark(name) {
    const config = getConfig();
    if (!config.bookmarks) return false;
    const before = config.bookmarks.length;
    config.bookmarks = config.bookmarks.filter(b => b.name !== name);
    if (config.bookmarks.length < before) {
        saveConfig(config);
        return true;
    }
    return false;
}

module.exports = { getConfig, saveConfig, getProfile, saveProfile, syncClaudePublicAlias, getProfileField, getBookmarks, saveBookmark, deleteBookmark, CONFIG_PATH };
