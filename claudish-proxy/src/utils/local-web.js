// ── Local Web Tools ──
// Provides web_search and web_fetch managed tools executed locally (not sent to upstream).
// These are called by adapters when the model requests web search/fetch tool calls.

const https = require('https');
const http = require('http');

// Block internal/private IP ranges
const BLOCKED_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /::1$/i,
  /^localhost$/i,
];

function isBlockedHost(hostname) {
  try {
    const normalized = hostname.replace(/:\d+$/, ''); // strip port
    return BLOCKED_RANGES.some(r => r.test(normalized));
  } catch {
    return true;
  }
}

function httpsGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isBlocked = isBlockedHost(urlObj.hostname);
    if (isBlocked) {
      return reject(new Error('Fetching internal/private addresses is not allowed.'));
    }
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const req = protocol.get(url, { timeout }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

// ── web_search ──
async function webSearch(query, maxResults = 5) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`;
  const res = await httpsGet(url);
  if (res.status !== 200) throw new Error(`DuckDuckGo returned status ${res.status}`);

  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('Failed to parse DuckDuckGo response'); }

  const results = [];
  if (data.RelatedTopics) {
    for (const topic of data.RelatedTopics) {
      if (results.length >= maxResults) break;
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.replace(/<[^>]+>/g, ''),
          url: topic.FirstURL,
          snippet: topic.Text.replace(/<[^>]+>/g, '').substring(0, 200)
        });
      }
    }
  }

  return { results, query, count: results.length };
}

// ── web_fetch ──
async function webFetch(url) {
  const res = await httpsGet(url);
  if (res.status >= 400) throw new Error(`Fetch failed with status ${res.status}`);

  const content = stripHtml(res.body).substring(0, 4000);
  const title = extractTitle(res.body) || url;
  const textContent = content.length > 0 ? content : '(no readable text content)';

  return { title, url, content: textContent, status: res.status };
}

// ── Main export ──
async function executeManagedWebTool(toolName, args) {
  switch (toolName) {
    case 'web_search': return webSearch(args.query || '', args.max_results || 5);
    case 'web_fetch':  return webFetch(args.url || '');
    default: throw new Error(`Unknown web tool: ${toolName}`);
  }
}

module.exports = { executeManagedWebTool };