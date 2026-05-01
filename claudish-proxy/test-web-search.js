// Test web search directly
const { executeManagedWebTool } = require('./utils/local-web');

async function test() {
    console.log('Testing web_search...');
    try {
        const result = await executeManagedWebTool('web_search', { 
            query: 'nodejs tutorial',
            max_results: 3 
        });
        console.log('SUCCESS:');
        console.log(result);
    } catch (e) {
        console.error('ERROR:', e.message);
    }

    console.log('\n\nTesting web_fetch...');
    try {
        const result = await executeManagedWebTool('web_fetch', { 
            url: 'https://example.com' 
        });
        console.log('SUCCESS:');
        console.log(result);
    } catch (e) {
        console.error('ERROR:', e.message);
    }
}

test();
