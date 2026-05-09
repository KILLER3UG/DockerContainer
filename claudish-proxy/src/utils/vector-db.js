const fs = require('fs');
const path = require('path');

const VECTOR_DB_FILE = path.join(__dirname, '..', 'august_infinite_memory.json');

/**
 * Ensures the DB file exists and returns its contents.
 */
function readDB() {
    if (!fs.existsSync(VECTOR_DB_FILE)) {
        fs.writeFileSync(VECTOR_DB_FILE, JSON.stringify([]));
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(VECTOR_DB_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

/**
 * Saves the DB contents.
 */
function writeDB(data) {
    fs.writeFileSync(VECTOR_DB_FILE, JSON.stringify(data, null, 2));
}

/**
 * Compute the cosine similarity between two vectors (arrays of numbers).
 * Returns a score between -1 and 1.
 */
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Save a new checkpoint with its embedding to the local vector DB.
 */
function saveCheckpointWithEmbedding(topic, summary, embedding) {
    const db = readDB();
    db.push({
        topic,
        summary,
        embedding,
        timestamp: new Date().toISOString()
    });
    writeDB(db);
}

/**
 * Search the local vector DB using a query embedding.
 * Returns the top K results.
 */
function searchCheckpoints(queryEmbedding, topK = 3) {
    const db = readDB();
    
    // Calculate similarity scores for all entries
    const scored = db.map(entry => {
        return {
            topic: entry.topic,
            summary: entry.summary,
            timestamp: entry.timestamp,
            score: cosineSimilarity(queryEmbedding, entry.embedding)
        };
    });
    
    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);
    
    // Return top K
    return scored.slice(0, topK);
}

module.exports = {
    saveCheckpointWithEmbedding,
    searchCheckpoints
};
