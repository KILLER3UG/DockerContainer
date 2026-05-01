// Quick test: send a request through the proxy and check if stats update
const http = require('http');

// 1. Get current stats
function getStats() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:8085/ui/stats?period=all', res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

// 2. Send a test request to /v1/messages
function sendTestRequest() {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: 'ling-2.6-flash-free',
            max_tokens: 50,
            messages: [{ role: 'user', content: 'say hello' }]
        });
        const req = http.request({
            hostname: 'localhost',
            port: 8085,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': 'test'
            }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// 3. Test SSE endpoint
function testSSE() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:8085/ui/stream', res => {
            console.log('SSE Status:', res.statusCode);
            console.log('SSE Content-Type:', res.headers['content-type']);
            let received = '';
            const timer = setTimeout(() => {
                res.destroy();
                resolve(received);
            }, 3000);
            res.on('data', c => {
                received += c.toString();
                if (received.includes('"stats"')) {
                    clearTimeout(timer);
                    res.destroy();
                    resolve(received);
                }
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log('=== STEP 1: Stats Before ===');
    const before = await getStats();
    console.log('Total requests:', before.totalRequests);
    console.log('Pending:', before.pendingRequests);
    console.log('Input tokens:', before.totalInputTokens);
    console.log('Output tokens:', before.totalOutputTokens);
    
    console.log('\n=== STEP 2: Sending test request ===');
    const response = await sendTestRequest();
    console.log('Response (first 300 chars):', response.substring(0, 300));
    
    console.log('\n=== STEP 3: Stats After ===');
    const after = await getStats();
    console.log('Total requests:', after.totalRequests);
    console.log('Pending:', after.pendingRequests);
    console.log('Input tokens:', after.totalInputTokens);
    console.log('Output tokens:', after.totalOutputTokens);
    console.log('Requests increased?', after.totalRequests > before.totalRequests ? 'YES ✓' : 'NO ✗');
    
    console.log('\n=== STEP 4: SSE Test ===');
    const sseData = await testSSE();
    console.log('SSE data received (first 300 chars):', sseData.substring(0, 300));
    
    if (sseData.includes('"stats"')) {
        console.log('SSE is broadcasting stats: YES ✓');
    } else {
        console.log('SSE is broadcasting stats: NO ✗');
    }
}

main().catch(e => console.error('FATAL:', e));
