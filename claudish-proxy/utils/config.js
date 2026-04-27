const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let cachedConfig = null;
let cachedMtime = 0;

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
        return config[name];
    }
    // Old flat format fallback
    return {
        targetUrl: config.targetUrl,
        currentModel: config.currentModel,
        apiKey: config.apiKey
    };
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

    config[name] = profileConfig;
    saveConfig(config);
}

// ── Custom Provider Bookmarks ──
function getBookmarks() {
    const config = getConfig();
    return config.bookmarks || [];
}

function saveBookmark(name, baseUrl, apiKey) {
    const config = getConfig();
    if (!config.bookmarks) config.bookmarks = [];
    const existingIndex = config.bookmarks.findIndex(b => b.name === name);
    const bookmark = { name, baseUrl, apiKey };
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

module.exports = { getConfig, saveConfig, getProfile, saveProfile, getProfileField, getBookmarks, saveBookmark, deleteBookmark, CONFIG_PATH };
