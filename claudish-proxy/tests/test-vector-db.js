const assert = require('assert');

const {
    hybridSearchEntries,
    searchCheckpointsByText
} = require('../src/utils/vector-db');

const entries = [
    {
        topic: 'Google OAuth Callback',
        summary: 'Laravel Socialite GoogleProvider rejected withState, so mobile and web auth callbacks were aligned with social_token and social_error.',
        metadata: {
            type: 'episode',
            project: 'CAPS-mobile',
            outcome: 'success',
            tags: ['auth', 'laravel', 'mobile']
        }
    },
    {
        topic: 'Proxy Dashboard Costs',
        summary: 'Claudish Proxy overview filters use local timezone boundaries and editable token pricing inputs.',
        metadata: {
            type: 'episode',
            project: 'claudish-proxy',
            tags: ['dashboard', 'cost']
        }
    },
    {
        topic: 'Terminal App Shell',
        summary: 'The mobile app should connect to a PTY websocket so xterm.js can drive a host terminal through the proxy.',
        metadata: {
            type: 'plan',
            project: 'august-app',
            tags: ['terminal', 'mobile', 'pty']
        }
    }
];

const authResults = hybridSearchEntries('google laravel auth callback withstate', entries, 3);
assert(authResults.length > 0, 'hybrid search should return matches');
assert.strictEqual(authResults[0].topic, 'Google OAuth Callback', 'BM25/vector fusion should rank exact auth memory first');
assert.strictEqual(authResults[0].retrieval.method, 'hybrid-rrf', 'results should expose the fusion method');
assert(authResults[0].bm25Score > 0, 'results should include BM25 scores');
assert(authResults[0].vectorScore > 0, 'results should include vector scores');

const filtered = hybridSearchEntries('terminal proxy dashboard auth', entries, 5, {
    filters: { project: 'august-app' }
});
assert.strictEqual(filtered.length, 1, 'metadata filters should narrow results');
assert.strictEqual(filtered[0].topic, 'Terminal App Shell', 'project filter should keep the app memory');

const tagFiltered = hybridSearchEntries('oauth callback', entries, 5, {
    filters: { tags: ['laravel'] }
});
assert.strictEqual(tagFiltered.length, 1, 'tag filters should work');
assert.strictEqual(tagFiltered[0].metadata.project, 'CAPS-mobile', 'tag filter should preserve metadata');

const currentDbResults = searchCheckpointsByText('__definitely_no_real_memory_query__', 2);
assert(Array.isArray(currentDbResults), 'DB-backed text search should return an array');

console.log('SUCCESS vector-db');
