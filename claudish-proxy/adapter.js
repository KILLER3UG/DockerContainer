const http = require('http');
const httpProxy = require('http-proxy');

const proxy = httpProxy.createProxyServer({});

const server = http.createServer((req, res) => {
    const target = 'http://host.docker.internal:1234';
    
    // 1. Intercept the response to fix the token usage fields
    proxy.on('proxyRes', (proxyRes, req, res) => {
        let body = [];
        proxyRes.on('data', (chunk) => body.push(chunk));
        proxyRes.on('end', () => {
            body = Buffer.concat(body).toString();
            try {
                if (proxyRes.headers['content-type']?.includes('application/json')) {
                    let json = JSON.parse(body);
                    // Translate usage fields for Claude Code
                    if (json.usage) {
                        json.usage.input_tokens = json.usage.prompt_tokens;
                        json.usage.output_tokens = json.usage.completion_tokens;
                    }
                    body = JSON.stringify(json);
                }
            } catch (e) {}
            res.end(body);
        });
    });

    // 2. Forward the request
    proxy.web(req, res, { target, changeOrigin: true, selfHandleResponse: true });
});

console.log('--- AI Adapter Active on Port 8080 ---');
server.listen(8080, '0.0.0.0');
