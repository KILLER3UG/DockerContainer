const fs = require('fs');
const path = require('path');

const SEMANTIC_FILE = path.join(__dirname, '..', 'august_semantic_memory.json');

const VALID_CATEGORIES = new Set([
    'user_preference',
    'user_detail',
    'project_info',
    'workflow_rule',
    'session_temp'
]);

const DEFAULT_TTL_DAYS = {
    user_preference: null,
    user_detail: null,
    project_info: 90,
    workflow_rule: null,
    session_temp: 1
};

function readDB() {
    if (!fs.existsSync(SEMANTIC_FILE)) {
        fs.writeFileSync(SEMANTIC_FILE, JSON.stringify([]));
        return [];
    }
    try {
        const data = JSON.parse(fs.readFileSync(SEMANTIC_FILE, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

function writeDB(data) {
    fs.writeFileSync(SEMANTIC_FILE, JSON.stringify(data, null, 2));
}

function isExpired(fact) {
    return fact.ttl && new Date(fact.ttl) < new Date();
}

function setFact(key, value, category = 'user_preference', ttlDays = null, source = 'unknown') {
    if (!key || typeof key !== 'string') throw new Error('key is required');
    if (!VALID_CATEGORIES.has(category)) throw new Error(`Invalid category: ${category}. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`);

    const db = readDB();
    const existingIndex = db.findIndex(f => f.key === key);
    const now = new Date().toISOString();

    const ttl = ttlDays !== null && ttlDays > 0
        ? new Date(Date.now() + ttlDays * 86400000).toISOString()
        : (ttlDays === 0 ? new Date(0).toISOString() : null);

    const fact = { key, value, category, source, created: now, updated: now, ttl };

    if (existingIndex >= 0) {
        fact.created = db[existingIndex].created;
        fact.updated = now;
        db[existingIndex] = fact;
    } else {
        db.push(fact);
    }

    writeDB(db);
    return fact;
}

function getFact(key) {
    const db = readDB();
    const fact = db.find(f => f.key === key);
    if (!fact) return null;
    if (isExpired(fact)) {
        deleteFact(key);
        return null;
    }
    return { ...fact };
}

function searchFacts(query) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    return readDB().filter(f => {
        if (isExpired(f)) return false;
        const haystack = `${f.key} ${f.value} ${f.category}`.toLowerCase();
        return terms.some(t => haystack.includes(t));
    });
}

function deleteFact(key) {
    const db = readDB();
    const before = db.length;
    const filtered = db.filter(f => f.key !== key);
    if (filtered.length < before) {
        writeDB(filtered);
        return true;
    }
    return false;
}

function getAllFacts() {
    const db = readDB();
    const active = db.filter(f => !isExpired(f));
    if (active.length < db.length) writeDB(active);
    return active;
}

function getFactsByCategory(category) {
    if (!VALID_CATEGORIES.has(category)) return [];
    return getAllFacts().filter(f => f.category === category);
}

function getFactsBySource(source) {
    if (!source) return [];
    return getAllFacts().filter(f => f.source === source);
}

function factCount() {
    return getAllFacts().length;
}

function clearExpired() {
    writeDB(readDB().filter(f => !isExpired(f)));
}

module.exports = {
    setFact,
    getFact,
    searchFacts,
    deleteFact,
    getAllFacts,
    getFactsByCategory,
    getFactsBySource,
    factCount,
    clearExpired,
    VALID_CATEGORIES,
    DEFAULT_TTL_DAYS
};
