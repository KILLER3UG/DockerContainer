# Claudish Proxy — Complete Documentation

## Table of Contents

1. [What is Claudish Proxy?](#what-is-claudish-proxy)
2. [How It Works (Architecture & Logic)](#how-it-works-architecture--logic)
3. [Getting API Keys (Step-by-Step)](#getting-api-keys-step-by-step)
4. [Installation & Setup](#installation--setup)
5. [Creating Launch Scripts](#creating-launch-scripts)
6. [Using with Claude Code](#using-with-claude-code)
7. [Using with OpenAI Codex](#using-with-openai-codex)
8. [Using with Cline / Other Tools](#using-with-cline--other-tools)
9. [Web UI Guide](#web-ui-guide)
10. [Custom Provider Setup](#custom-provider-setup)
11. [Advanced Features](#advanced-features)
12. [Troubleshooting](#troubleshooting)

---

## What is Claudish Proxy?

**Claudish Proxy** is a lightweight HTTP bridge that lets you run **Claude Code** and **OpenAI Codex** (and other OpenAI-compatible tools) simultaneously, routing each to different AI providers through a single local endpoint.

### The Problem It Solves

Normally, Claude Code only works with Anthropic's API, and Codex only works with OpenAI's API. Free-tier access to these is limited or non-existent. Meanwhile, providers like **Kilocode**, **Opencode**, and **OpenRouter** offer free access to powerful models (Minimax, Gemini, Llama, DeepSeek, etc.) through OpenAI-compatible APIs.

**Claudish bridges this gap** by:
- Pretending to be Anthropic's API for Claude Code
- Pretending to be OpenAI's API for Codex
- Actually sending requests to whichever free provider you choose
- Translating between formats automatically

### Key Capabilities

| Feature | Description |
|---------|-------------|
| **Multi-client support** | Claude + Codex run at the same time without conflicts |
| **Profile-based routing** | Each client gets its own provider, model, and API key |
| **Format translation** | Translates Anthropic ↔ OpenAI API formats automatically |
| **Smart context compaction** | Only compacts when approaching the model's real context limit |
| **Auto model detection** | Detects context windows from model IDs automatically |
| **Custom providers** | Add any OpenAI-compatible API endpoint |
| **Self-healing** | Detects common tool errors and suggests fixes |
| **Real-time Web UI** | Monitor requests, model thinking, and tool calls live |
| **Windows-aware** | Informs models to use PowerShell instead of bash |

---

## How It Works (Architecture & Logic)

### The Big Picture

```
┌─────────────┐     ┌─────────────┐
│ Claude Code │     │ OpenAI Codex│
│  (client)   │     │   (client)  │
└──────┬──────┘     └──────┬──────┘
       │                   │
       │ /v1/messages      │ /v1/chat/completions
       │ /v1/models        │ /v1/responses
       │                   │
       └─────────┬─────────┘
                 │
       ┌─────────▼─────────┐
       │  Claudish Proxy   │  ← localhost:8085
       │   (HTTP Server)   │
       └─────────┬─────────┘
                 │
       ┌─────────┴─────────┐
       │                   │
┌──────▼──────┐   ┌───────▼──────┐
│   Anthropic │   │    OpenAI    │
│   Adapter   │   │   Adapter    │
└──────┬──────┘   └───────┬──────┘
       │                   │
       │  translates to    │ passes through /
       │  OpenAI format    │ translates Responses API
       │                   │
       └─────────┬─────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
┌───▼───┐  ┌───▼───┐  ┌────▼────┐
│KiloCode│  │Opencode│  │OpenRouter│
│  etc.  │  │  etc.  │  │  etc.   │
└────────┘  └────────┘  └─────────┘
```

### Step-by-Step Request Flow

**When Claude Code sends a request:**

1. Claude Code thinks it's talking to Anthropic. It sends a `POST /v1/messages` request with:
   - Anthropic-style message format (roles: `user`, `assistant`)
   - Anthropic tool definitions (`name`, `input_schema`)
   - Anthropic parameters (`max_tokens`, `stop_sequences`)

2. The **bridge** (`bridge.js`) receives the request and routes it to the **Anthropic Adapter** because the path contains `/v1/messages`.

3. The **Anthropic Adapter** (`adapters/anthropic.js`):
   - Reads the `claude` profile from `config.json` to get the upstream URL, model ID, and API key
   - Translates Anthropic messages to OpenAI format:
     - `system` prompt → OpenAI `system` message
     - `user`/`assistant` messages → OpenAI `user`/`assistant` messages
     - `tool_use` blocks → OpenAI `tool_calls`
     - `tool_result` blocks → OpenAI `tool` messages
   - Translates Anthropic tool definitions to OpenAI function definitions
   - Encodes tool IDs using base64url for deterministic bidirectional mapping
   - Performs **smart context compaction** (only if estimated tokens > 88% of context window)
   - Appends Windows environment hints to the system prompt
   - Applies **self-healing** to tool error results
   - Sends the translated request to the upstream provider

4. The **upstream provider** (e.g., Opencode) receives an OpenAI-format request and returns an OpenAI-format response.

5. The **Anthropic Adapter** translates the response back:
   - OpenAI `assistant` message → Anthropic `message` with `text` content
   - OpenAI `tool_calls` → Anthropic `tool_use` blocks
   - OpenAI `reasoning` → Anthropic text prefixed with 🤔
   - OpenAI `finish_reason` → Anthropic `stop_reason`

6. Claude Code receives what looks like a normal Anthropic response and works perfectly.

**When Codex sends a request:**

1. Codex thinks it's talking to OpenAI. It sends a `POST /v1/responses` or `POST /v1/chat/completions` request.

2. The **bridge** routes it to the **OpenAI Adapter** (`adapters/openai.js`).

3. The **OpenAI Adapter**:
   - Reads the `codex` profile from `config.json`
   - For `/v1/responses`: translates the Responses API format to Chat Completions format
   - For `/v1/chat/completions`: passes through mostly as-is
   - Performs smart context compaction
   - Appends Windows environment hints
   - Applies self-healing
   - Sends to upstream

4. The upstream returns an OpenAI-format response.

5. For `/v1/responses`, the adapter **synthesizes SSE events** manually because free providers don't support the Responses API natively. It generates the full event sequence: `response.created` → `response.in_progress` → text deltas → `response.completed` → `[DONE]`.

6. Codex receives what looks like a normal OpenAI streaming response.

---

## Technical Deep Dive: How Everything Works

This section explains the internals of every major component — the fake model list, adapters, prompt injection, context compaction, tool ID mapping, and self-healing. If you want to understand (or modify) the proxy, read this.

---

### 1. Fake Model List (`GET /v1/models`)

#### The Problem

Claude Code and Codex both call `GET /v1/models` on startup to discover what models are available. Claude Code expects Anthropic models (`claude-sonnet-4-6`, etc.). Codex expects OpenAI models (`gpt-4o`, etc.).

But the proxy doesn't actually host these models. It forwards to free-tier providers. If we returned the *real* upstream models, Claude Code would show `minimax-m2.5-free` in its UI, which would confuse users and might cause compatibility issues.

#### The Solution

The proxy serves a **hardcoded fake model list**:

```javascript
// bridge.js — Fake model list endpoint
if (cleanPath.includes('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
        data: [
            { id: 'claude-sonnet-4-6' },
            { id: 'gpt-5.4' },
            { id: 'gpt-5.5' },
            { id: 'gpt-4o' }
        ]
    }));
}
```

**What this achieves:**
- Claude Code sees `claude-sonnet-4-6` and thinks it's talking to Anthropic
- Codex sees `gpt-5.4`, `gpt-5.5`, `gpt-4o` and thinks it's talking to OpenAI
- Neither client knows the *actual* model being used upstream

**How the real model is selected:** The proxy completely ignores the `model` field sent by the client. Instead, it reads `cfg.currentModel` from the profile config (`config.json`). So when Claude asks for `claude-sonnet-4-6`, the proxy actually sends `minimax-m2.5-free` (or whatever you configured) to the upstream.

#### Why This Matters

This deception is the core trick that makes the proxy work. Claude Code has hardcoded assumptions about Anthropic models:
- It knows context window sizes for Claude models
- It formats tool calls expecting Claude behavior
- It has custom UI for "Claude Sonnet"

By pretending to be Claude, Claude Code behaves correctly. The proxy handles all the translation so the upstream free model receives compatible requests.

---

### 2. Model Hijacking

#### How It Works

In both adapters, the client's requested model is **replaced** with the profile's configured model:

**Anthropic adapter:**
```javascript
// adapters/anthropic.js
const oReq = {
    model: cfg.currentModel,  // <-- IGNORES aReq.model
    messages: openaiMessages
};
```

**OpenAI adapter:**
```javascript
// adapters/openai.js
let requestModel = cfg.currentModel;
// Optional: Ollama-style model override from auth header
const authHeader = req.headers['authorization'] || '';
if (authHeader.includes('Bearer model:')) {
    const extractedModel = authHeader.split('model:')[1].trim();
    requestModel = extractedModel;
}
oReq.model = requestModel;
```

#### Ollama-Style Override

The OpenAI adapter supports an **optional override** via the `Authorization` header:
```
Authorization: Bearer model:meta/llama-3.1-8b-instruct
```

If this header is present, the proxy uses that model ID instead of the profile default. This is useful for quickly testing different models without changing the config.

**Without the override header:** The proxy always uses `cfg.currentModel` from the `codex` profile.

---

### 3. Anthropic Adapter (`adapters/anthropic.js`)

This is the most complex adapter. It translates Anthropic's `/v1/messages` API to OpenAI's `/v1/chat/completions` API.

#### 3.1 Request Translation: Anthropic → OpenAI

**Incoming Anthropic request format:**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "messages": [
    { "role": "user", "content": "List files" }
  ],
  "tools": [
    {
      "name": "list_files",
      "description": "List files in a directory",
      "input_schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
    }
  ],
  "tool_choice": { "type": "tool", "name": "list_files" }
}
```

**Step 1: System Prompt Injection**

The adapter prepends a hardcoded Windows system prompt, then appends the user's system prompt:

```javascript
let systemPrompt = 'IMPORTANT: ALWAYS ignore node_modules, .git, dist, and build directories...\n\n' +
    'ENVIRONMENT: You are running on Windows (PowerShell). Use Windows commands and paths.\n' +
    '- Use PowerShell syntax (e.g., Get-ChildItem, Select-String, Test-Path) NOT bash...\n' +
    '- Use backslash paths (C:\\Users\\...) NOT forward slash (/home/...)...';

if (aReq.system) {
    systemPrompt += '\n\n' + aReq.system;  // Append user's system prompt
}
openaiMessages.push({ role: 'system', content: systemPrompt });
```

**Why this matters:** Most AI models are trained primarily on Linux/macOS examples. When running on Windows, they constantly suggest `ls`, `grep`, `cat`, and `/home/user` paths. This prompt explicitly tells the model: "You are on Windows. Use PowerShell."

**Step 2: Tool Definition Translation**

Anthropic tools use `input_schema`. OpenAI uses `parameters` inside a `function` object:

```javascript
function translateTools(anthropicTools, ctx) {
    return anthropicTools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,  // <-- same JSON Schema, different field name
            strict: t.strict
        }
    }));
}
```

**Step 3: Message Translation**

This is where the complexity lives. Anthropic messages can contain **content blocks** (arrays of objects), while OpenAI uses flat strings or `tool_calls`/`tool` messages.

| Anthropic | OpenAI |
|-----------|--------|
| `{"role":"user","content":"hello"}` | `{"role":"user","content":"hello"}` |
| `{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"toolu_01","name":"read","input":{"path":"x"}}]}` | `{"role":"assistant","content":"hi","tool_calls":[{"id":"call_01","type":"function","function":{"name":"read","arguments":"{\"path\":\"x\"}"}}]}` |
| `{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file content"}]}` | `{"role":"tool","tool_call_id":"call_01","content":"file content"}` |

The adapter iterates over each message, detects content block types, and transforms them. It also **merges consecutive same-role messages** (except `tool`) to comply with OpenAI's alternating roles requirement.

**Step 4: Tool Result Scrubbing**

Tool results often contain noisy directory listings. The adapter filters out lines containing `node_modules/`, `.git/`, `dist/`, `build/` to reduce token waste:

```javascript
openaiMessages.forEach(m => {
    if (m.role === 'tool' && typeof m.content === 'string') {
        const cleanLines = m.content.split('\n').filter(line =>
            !line.includes('node_modules/') &&
            !line.includes('.git/') &&
            !line.includes('dist/') &&
            !line.includes('build/')
        );
        m.content = cleanLines.join('\n');
    }
});
```

**Step 5: max_tokens Floor**

Free-tier models often default to tiny output limits (~256 tokens). The proxy enforces a minimum:

```javascript
const clientMaxTokens = aReq.max_tokens || 2048;
oReq.max_tokens = Math.max(1024, Math.min(clientMaxTokens, 4096));
```

This ensures responses aren't cut off mid-sentence. If the client asks for 256, the proxy sends 1024. If the client asks for 8192, the proxy caps at 4096 (most free models can't handle more).

#### 3.2 Response Translation: OpenAI → Anthropic

**Incoming OpenAI response:**
```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Here's what I found...",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": { "name": "read_file", "arguments": "{\"path\":\"README.md\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

**Step 1: Extract reasoning content**

If the upstream includes `reasoning` or `reasoning_content`, it's extracted and prefixed with 🤔:

```javascript
if (reasoningContent) {
    content.push({ type: 'text', text: '🤔 ' + reasoningContent });
}
```

**Step 2: Map tool calls to Anthropic `tool_use` blocks**

Each OpenAI `tool_calls` entry becomes an Anthropic `tool_use` block. The critical part is **ID mapping** (see Section 5).

**Step 3: Map `finish_reason` to `stop_reason`**

| OpenAI `finish_reason` | Anthropic `stop_reason` |
|------------------------|------------------------|
| `tool_calls` | `tool_use` |
| `stop` | `end_turn` |
| `length` | `max_tokens` |

**Step 4: Return Anthropic-format response**

```json
{
  "id": "msg_123456",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-6",
  "stop_reason": "tool_use",
  "content": [
    { "type": "text", "text": "Here's what I found..." },
    { "type": "tool_use", "id": "toolu_xyz", "name": "read_file", "input": { "path": "README.md" } }
  ]
}
```

Notice the `model` field is set to the **client's requested model** (`claude-sonnet-4-6`), not the upstream model. This maintains the illusion.

#### 3.3 SSE Parsing

Some upstream providers return streaming responses (SSE). The adapter has a `parseSSEToJSON()` function that aggregates all SSE chunks into a single JSON object:

```javascript
// Parses lines like:
// data: {"choices":[{"delta":{"content":"Hello"}}]}
// data: {"choices":[{"delta":{"content":" world"}}]}
// data: [DONE]

// Into:
// { choices: [{ message: { content: "Hello world" } }] }
```

It handles:
- Content accumulation across chunks
- Reasoning content accumulation
- Tool call accumulation (merging partial `function.arguments` across chunks)
- Usage extraction from the final chunk

---

### 4. OpenAI Adapter (`adapters/openai.js`)

This adapter handles `/v1/chat/completions` and `/v1/responses`.

#### 4.1 Chat Completions Path

For `/v1/chat/completions`, the request is already in OpenAI format, so the adapter mostly passes it through after:
1. Injecting the Windows system prompt
2. Applying model hijacking
3. Running smart context compaction
4. Applying self-healing

#### 4.2 Responses API Path (`/v1/responses`)

Codex uses the newer OpenAI **Responses API**, which has a completely different format:

**Codex sends:**
```json
{
  "model": "gpt-5.5",
  "instructions": "You are a helpful coding assistant...",
  "input": [
    { "role": "user", "content": "Fix this bug" },
    { "type": "function_call", "call_id": "fc-1", "name": "read_file", "arguments": {"path": "app.js"} },
    { "type": "function_call_output", "call_id": "fc-1", "output": "const x = 1;" }
  ],
  "tools": [ ... ],
  "stream": true
}
```

**The adapter translates this to Chat Completions format:**

```javascript
function translateResponsesInput(oReq) {
    const messages = [];
    // instructions → system message
    if (oReq.instructions) messages.push({ role: 'system', content: oReq.instructions });

    // input items → messages with tool grouping
    let pendingToolCalls = [];
    input.forEach(item => {
        if (item.type === 'function_call') {
            pendingToolCalls.push({
                id: item.call_id,
                type: 'function',
                function: { name: item.name, arguments: JSON.stringify(item.arguments) }
            });
        } else if (item.type === 'function_call_output') {
            // Flush pending tool calls as assistant message
            messages.push({ role: 'assistant', content: '', tool_calls: pendingToolCalls });
            pendingToolCalls = [];
            // Then add tool result
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
        } else {
            messages.push({ role: item.role, content: item.content });
        }
    });
    oReq.messages = messages;
}
```

**Key insight:** The Responses API interleaves `function_call` and `function_call_output` items in a flat array. Chat Completions requires strict alternation: `assistant` (with `tool_calls`) → `tool` → `assistant` → `tool`. The adapter groups consecutive `function_call` items into a single assistant message, then emits the `function_call_output` as `tool` messages.

#### 4.3 SSE Synthesis for Responses API

Free providers don't support the Responses API. So the adapter:
1. Sends a **non-streaming** request to the upstream
2. Gets a complete JSON response
3. **Manually synthesizes** the entire SSE event sequence that Codex expects:

```
data: {"type":"response.created","response":{...}}

data: {"type":"response.in_progress","response":{...}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message",...}}

data: {"type":"response.content_part.added",...}

data: {"type":"response.output_text.delta","delta":"Here's"}

data: {"type":"response.output_text.delta","delta":" the fix"}
...

data: {"type":"response.content_part.done",...}

data: {"type":"response.output_item.done",...}

data: {"type":"response.completed","response":{...}}

data: [DONE]
```

The text is streamed in ~20-character chunks to simulate real-time generation. Tool call arguments are similarly streamed chunk-by-chunk.

This synthesis is what allows Codex to work with *any* Chat Completions provider.

#### 4.4 Streaming Matrix

The adapter handles four combinations of upstream/client streaming:

| Upstream | Client | Behavior |
|----------|--------|----------|
| Stream | Stream | Forward SSE directly |
| JSON | Stream | Synthesize single SSE event from JSON |
| Stream | JSON | Parse SSE into JSON |
| JSON | JSON | Passthrough JSON directly |

---

### 5. Deterministic Tool ID Mapping

#### The Problem

Anthropic tool IDs look like: `toolu_01AbC123...`
OpenAI tool IDs look like: `call_01XyZ789...`

When Claude Code sends a `tool_use` with ID `toolu_01AbC`, the proxy must tell the upstream "call this tool with ID `call_01XyZ`". On the next turn, when Claude sends the `tool_result` with `tool_use_id: "toolu_01AbC"`, the proxy must map it back to `call_01XyZ`.

**The naive solution:** Use a shared Map: `Map<anthropicId, openaiId>`. But this breaks when Claude and Codex run simultaneously — their tool IDs collide in the shared Map.

**The correct solution:** Use **deterministic bidirectional encoding** with no shared state.

#### How It Works

```javascript
// Anthropic ID → OpenAI ID
function getOpenAIId(anthropicId) {
    // anthropicId = "toolu_base64url(call_xxx)"
    const encoded = anthropicId.slice(6); // strip "toolu_"
    return Buffer.from(encoded, 'base64url').toString('utf8');
}

// OpenAI ID → Anthropic ID
function getAnthropicId(openaiId) {
    const encoded = Buffer.from(openaiId).toString('base64url');
    return 'toolu_' + encoded;
}
```

**Example:**
- Upstream generates tool call ID: `call_abc123`
- Proxy encodes to Anthropic: `toolu_Y2FsbF9hYmMxMjM` (base64url of `call_abc123`)
- Claude receives `toolu_Y2FsbF9hYmMxMjM` and later sends it back in `tool_result`
- Proxy decodes: `Buffer.from('Y2FsbF9hYmMxMjM', 'base64url')` → `call_abc123`

**Why this is perfect:**
- ✅ Zero shared state — each request computes IDs independently
- ✅ Concurrent-safe — Claude + Codex can run simultaneously with no collisions
- ✅ Bidirectional — encode and decode are pure functions
- ✅ No memory leaks — no Maps to clean up

---

### 6. Smart Context Compaction

#### The Problem

Long conversations exceed the model's context window. Naive solutions truncate to a fixed number of messages (e.g., "keep last 20"), but this:
- Drops important context arbitrarily
- Doesn't account for message length variation
- Compacts even when not needed

#### The Algorithm

```javascript
// 1. Detect context window
const contextWindow = await getModelContextWindow(modelId, providerUrl, apiKey);
// e.g., 256,000 tokens for minimax-m2.5-free

// 2. Set threshold (88% of window)
const threshold = Math.floor(contextWindow * 0.88); // 225,280 tokens

// 3. Estimate current token usage
const estimatedTokens = estimateTokens(messages, tools);

// 4. Only compact if over threshold
if (estimatedTokens > threshold) {
    // Keep all system messages
    const systemMsgs = messages.filter(m => m.role === 'system');
    // Drop oldest non-system messages until under threshold
    const otherMsgs = messages.filter(m => m.role !== 'system');
    let kept = otherMsgs;
    while (kept.length > 1) {
        const testMessages = [...systemMsgs, ...kept];
        const testTokens = estimateTokens(testMessages, tools);
        if (testTokens <= threshold) break;
        kept = kept.slice(1); // Drop oldest
    }
    messages = [...systemMsgs, ...kept];
}
```

**Key properties:**
- **System messages are sacred** — never dropped (they contain the Windows prompt)
- **Binary search style** — drops from the front (oldest) until under threshold
- **88% threshold** — leaves headroom for the model's response
- **Only runs when needed** — small conversations pass through untouched

**If still over threshold after dropping messages:** Individual long messages (especially tool results) are truncated to 8,000 characters.

#### Token Estimation

The proxy doesn't use tiktoken (too heavy). Instead it uses lightweight character heuristics:

```javascript
function estimateStringTokens(str) {
    let tokens = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        // CJK characters: ~1.5 chars per token (0.67 tokens per char)
        if (code >= 0x4E00 && code <= 0x9FFF) { tokens += 0.67; continue; }
        // ASCII: ~4 chars per token (0.25 tokens per char)
        tokens += 0.25;
    }
    return Math.ceil(tokens);
}
```

- CJK (Chinese/Japanese/Korean): `0.67` tokens per character
- ASCII/English: `0.25` tokens per character (~4 chars/token)
- Message overhead: `+4` tokens per message
- Tool overhead: `+50` tokens per tool definition

This is "good enough" for compaction decisions. It errs on the side of caution (slightly overestimates).

---

### 7. Self-Healing (`utils/selfheal.js`)

#### The Problem

When a tool execution fails, the model often gets stuck:
- It suggests `ls` on Windows → "command not found"
- It uses backslash paths in bash → "No such file or directory"
- It hits a permission error → stops and asks the user

#### How It Works

After every tool result, the proxy scans the content for error patterns:

```javascript
function detectError(content) {
    const lower = content.toLowerCase();
    return lower.includes('error:') ||
           lower.includes('exit code') ||
           lower.includes('command not found') ||
           lower.includes('permission denied');
}
```

If an error is detected, it builds **context-aware hints**:

**Pattern 1: PowerShell commands in bash**
```
Get-ChildItem → ls, find, tree
Select-Object → cut, awk, grep
Test-Path → test -e, [ -f ]
```
Hint: `[Proxy Self-Heal]: You used PowerShell commands (Get-ChildItem) in a bash/unix shell. Use bash equivalents instead: Get-ChildItem → ls, find, tree. Do NOT stop — fix the command and try again.`

**Pattern 2: Windows paths in Unix**
```
C:\Users\rober → /home/rober
```
Hint: `[Proxy Self-Heal]: You may be using Windows-style backslash paths in a unix shell. Use forward slashes / instead.`

**Pattern 3: Permission denied**
Hint: `[Proxy Self-Heal]: Permission denied. Try using sudo, checking file permissions with ls -la... Do NOT stop — fix the command and try again.`

**Pattern 4: Generic error (catch-all)**
Hint: `[Proxy Self-Heal]: The previous command failed. Read the error carefully, fix the issue, and retry with a corrected command. Do NOT stop — keep trying until it works.`

These hints are **appended to the tool result content** before sending to the model. The model sees the error + the hint in the same message, which dramatically improves its ability to self-correct.

---

### 8. Request Inspector (`utils/inspector.js`)

The inspector captures the full lifecycle of each request:

```javascript
// When request arrives:
captureRequest(reqId, { model, messages, tools, endpoint });

// When response arrives:
captureResponse(reqId, responseBody, thinking, toolCalls, error);
```

It stores the last 20 cycles in memory. The Web UI's **Request Inspector** panel displays:
- 🤔 **Thinking** — model reasoning content
- 🔧 **Tool Calls** — tools invoked with arguments
- 💬 **Response** — final text output
- ❌ **Errors** — proxy or upstream errors
- 📄 **Raw JSON** — full request/response for debugging

This is invaluable for debugging why a model behaves unexpectedly.

---

### 9. File Structure (Updated)

```
claudish-proxy/
├── bridge.js              # Main HTTP server & routing
│                          #   - Serves fake /v1/models
│                          #   - Routes to adapters by path
│                          #   - Custom provider endpoints
│                          #   - Bookmark CRUD endpoints
│                          #   - UI static file serving
├── launch.js              # Interactive CLI launcher
│                          #   - Fetches models from proxy
│                          #   - Prompts for selection
│                          #   - Saves to profile config
│                          #   - Sets env vars & launches tool
├── ui.html                # Web dashboard (single HTML file)
│                          #   - Status cards, profile panels
│                          #   - Custom provider + bookmarks
│                          #   - Request Inspector
│                          #   - Live request traffic table
├── config.json            # Profile configs (mounted volume)
│                          #   - claude: { model, url, key, contextWindow }
│                          #   - codex: { model, url, key, contextWindow }
│                          #   - bookmarks: [ { name, baseUrl, apiKey } ]
├── .env                   # API keys (Docker env file)
├── Dockerfile             # Node.js 20-slim image
├── docker-compose.yml     # Docker orchestration
├── claude-local.bat       # Launch Claude through proxy
├── codex-local.bat        # Launch Codex through proxy
├── adapters/
│   ├── anthropic.js       # /v1/messages handler (Claude)
│   │                      #   - Anthropic ↔ OpenAI translation
│   │                      #   - System prompt injection
│   │                      #   - Tool ID base64url mapping
│   │                      #   - SSE aggregation
│   │                      #   - Context compaction
│   └── openai.js          # /v1/chat/completions & /v1/responses (Codex)
│                          #   - Responses API → Chat Completions translation
│                          #   - SSE synthesis for Responses API
│                          #   - Streaming passthrough matrix
│                          #   - Context compaction
└── utils/
    ├── config.js          # Config loader with mtime caching
    ├── logger.js          # Activity & request tracking
    │                      #   - Request lifecycle capture
    │                      #   - Pending request counting
    ├── models.js          # Model registry & context window detection
    │                      #   - KNOWN_MODELS lookup table
    │                      #   - Pattern inference from model ID
    │                      #   - OpenRouter API fallback
    ├── tokens.js          # Lightweight token estimation
    │                      #   - CJK-aware character counting
    │                      #   - Message + tool overhead
    ├── selfheal.js        # Error detection & fix hints
    │                      #   - PowerShell-in-bash detection
    │                      #   - Path separator detection
    │                      #   - Generic error catch-all
    └── inspector.js       # Request capture for debug UI
```

---

### Profile System

Config is stored in `config.json` as profiles:

```json
{
  "claude": {
    "currentModel": "minimax-m2.5-free",
    "targetUrl": "https://opencode.ai/zen/v1/chat/completions",
    "apiKey": "your_key_here",
    "contextWindow": 256000
  },
  "codex": {
    "currentModel": "inclusionai/ling-2.6-1t:free",
    "targetUrl": "https://api.kilo.ai/api/gateway/chat/completions",
    "apiKey": "your_key_here",
    "contextWindow": 256000
  },
  "customProvider": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "your_key_here"
  }
}
```

Each profile is completely independent — different model, different provider, different key.

### Why Deterministic Tool ID Mapping Matters

Anthropic uses IDs like `toolu_01AbC...`. OpenAI uses IDs like `call_01AbC...`. The proxy needs to map between them so that when:
- Claude sends `tool_use` with ID `toolu_xxx`
- The upstream receives `tool_call` with ID `call_yyy`
- The proxy must remember that `toolu_xxx` ↔ `call_yyy`

Instead of using shared Maps (which break with concurrent clients), the proxy uses **base64url encoding**:
```
toolu_<base64url(call_xxx)>  →  call_xxx
```
This is deterministic, bidirectional, and requires zero shared state.

---

## Getting API Keys (Step-by-Step)

You need at least one API key from a provider. All providers listed here offer **free-tier models**.

### Option 1: KiloCode

1. Go to **https://kilo.ai**
2. Sign up for an account (Google/GitHub/email)
3. Once logged in, go to your **Dashboard** → **API Keys**
4. Click **Create API Key**
5. Copy the key (starts with `eyJ...` — it's a JWT)
6. Paste it into your `.env` file:
   ```env
   KILOCODE_API_KEY=eyJhbGci...
   ```

**What you get:** Free access to models like Minimax, Ling, Gemini, Llama.

### Option 2: Opencode

1. Go to **https://opencode.ai**
2. Sign up for an account
3. Go to **Settings** → **API** or **Developer**
4. Generate an API key
5. Copy the key
6. Paste it into your `.env` file:
   ```env
   OPENCODE_API_KEY=sk-...
   ```

**What you get:** Free access to Minimax, Ling, and other models.

### Option 3: OpenRouter

1. Go to **https://openrouter.ai**
2. Sign up for an account
3. Go to **Keys** → **Create Key**
4. Give it a name (e.g., "Claudish")
5. Copy the key (starts with `sk-or-v1-...`)
6. Paste it into your `.env` file:
   ```env
   OPENROUTER_API_KEY=sk-or-v1-...
   ```

**What you get:** The largest selection of free models (Minimax, Gemini, Llama, DeepSeek, Qwen, Mistral, etc.). Also provides model metadata like context window sizes.

### Option 4: Your Own API Base URL (Any Provider)

You can use **any** provider that implements the OpenAI Chat Completions API. Examples:

| Provider | Sign Up At | Base URL |
|----------|-----------|----------|
| **Together AI** | https://api.together.xyz | `https://api.together.xyz/v1` |
| **Fireworks AI** | https://fireworks.ai | `https://api.fireworks.ai/inference/v1` |
| **Groq** | https://groq.com | `https://api.groq.com/openai/v1` |
| **Local (Ollama)** | Install Ollama | `http://localhost:11434/v1` |
| **Local (LM Studio)** | Install LM Studio | `http://localhost:1234/v1` |

**For custom providers**, you don't need `.env` entries. Just enter the base URL and API key directly in the Web UI's **Custom Provider** section.

---

## Installation & Setup

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- PowerShell (Windows)
- At least one API key (see [Getting API Keys](#getting-api-keys-step-by-step))
- Node.js (for `launch.js` — optional, batch files work without it)

### Step 1: Navigate to the Project

```powershell
cd C:\Users\rober\LocalFolders\DockerContainer\claudish-proxy
```

### Step 2: Create the Environment File

Create a file named `.env` in the same directory as `docker-compose.yml`:

```powershell
notepad .env
```

Paste your keys:

```env
KILOCODE_API_KEY=eyJhbGci...
OPENCODE_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-v1-...
```

Save and close. You only need keys for providers you plan to use.

### Step 3: Build & Start the Container

```powershell
docker compose up --build -d
```

This:
- Builds the Docker image from the `Dockerfile`
- Starts the container named `claudish-proxy`
- Maps port `8085` on your machine to port `8080` in the container
- Mounts `config.json` so settings persist across restarts
- Loads API keys from `.env`

### Step 4: Verify It's Running

```powershell
docker ps
```

You should see `claudish-proxy` running.

### Step 5: Open the Web UI

Navigate to **http://localhost:8085** in your browser.

### Step 6: Select Models

1. Click **🔄 Refresh Models** to fetch available free models from all configured providers
2. In the **Claude Profile** panel, select a model from the dropdown
3. Click **Save**
4. In the **Codex Profile** panel, select a model from the dropdown
5. Click **Save**

### Step 7: Create Launch Scripts

See [Creating Launch Scripts](#creating-launch-scripts) below.

### Useful Docker Commands

```powershell
# Stop the proxy
docker compose down

# Restart the proxy
docker compose down
docker compose up --build -d

# View live logs
docker logs claudish-proxy -f

# View last 50 lines
docker logs claudish-proxy --tail 50

# Restart just the container
docker restart claudish-proxy
```

---

## Creating Launch Scripts

You need to tell Claude Code and Codex to connect to the proxy instead of their real APIs. The project includes two ready-to-use batch files that do this automatically.

### Included Batch Files

The following files are already in the `claudish-proxy` folder:

#### `claude-local.bat`

```bat
@echo off
node "%~dp0launch.js" claude %*
```

This batch file:
- Calls `launch.js` with `claude` as the argument
- Lets you pass extra arguments through to Claude Code (e.g., `claude-local.bat --verbose`)
- The `%~dp0` ensures it always finds `launch.js` in the same folder

#### `codex-local.bat`

```bat
@echo off
node "%~dp0launch.js" codex %*
```

Same pattern, but for Codex.

### What `launch.js` Does Behind the Scenes

When you run `claude-local.bat` or `codex-local.bat`, `launch.js`:

1. **Fetches models** from the proxy at `http://localhost:8085`
2. **Shows an interactive list** of available models with numbers
3. **Lets you select** a model (or keep the current one by typing `0`)
4. **Saves your choice** to `config.json` under the correct profile
5. **Sets environment variables** internally:
   - For Claude: `ANTHROPIC_BASE_URL=http://localhost:8085/v1`
   - For Codex: `OPENAI_API_KEY=local-proxy` + custom provider config
6. **Launches the tool** with the right model selected

### How to Use the Batch Files

**Launch Claude:**
```powershell
.\claude-local.bat
```

Or with extra arguments:
```powershell
.\claude-local.bat --verbose
```

**Launch Codex:**
```powershell
.\codex-local.bat
```

**If you want to run them from anywhere**, add the `claudish-proxy` folder to your PATH or copy the batch files to a folder that's already on PATH (e.g., `C:\Users\rober\bin`).

### Running Both at the Same Time

Open **two separate PowerShell windows**:

**Window 1:**
```powershell
cd C:\Users\rober\LocalFolders\DockerContainer\claudish-proxy
.\claude-local.bat
```

**Window 2:**
```powershell
cd C:\Users\rober\LocalFolders\DockerContainer\claudish-proxy
.\codex-local.bat
```

Both will connect to the same proxy but use different profiles (and thus different models/providers).

### Alternative: Simple Batch Files (No Interactive Selection)

If you prefer simple batch files that skip the interactive model selection and just use what's already saved in `config.json`, create these files:

#### Simple `claude-simple.bat`

```bat
@echo off
echo [Claudish] Starting Claude Code with proxy...
set ANTHROPIC_BASE_URL=http://localhost:8085
claude
```

**How it works:**
- `@echo off` — hides command echo for cleaner output
- `set ANTHROPIC_BASE_URL=http://localhost:8085` — tells Claude Code to send all API requests to the proxy instead of Anthropic's servers
- `claude` — launches Claude Code with the model from `config.json`

#### Simple `codex-simple.bat`

```bat
@echo off
echo [Claudish] Starting Codex with proxy...
set OPENAI_API_KEY=dummy_key_not_used
set OPENAI_BASE_URL=http://localhost:8085
codex
```

**How it works:**
- `set OPENAI_API_KEY=dummy_key_not_used` — Codex requires an API key to be set, but the proxy ignores it and uses the key from your profile config
- `set OPENAI_BASE_URL=http://localhost:8085` — tells Codex to send all API requests to the proxy
- `codex` — launches Codex

### Alternative: PowerShell One-Liners

If you don't want batch files at all, you can run these directly in PowerShell:

**For Claude:**
```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:8085"; claude
```

**For Codex:**
```powershell
$env:OPENAI_API_KEY = "dummy"; $env:OPENAI_BASE_URL = "http://localhost:8085"; codex
```

### Alternative: Using `launch.js` Directly (Interactive)

Run the launcher directly for an interactive model selection:

```powershell
node launch.js
```

This will:
1. Fetch available models from all providers
2. Show a numbered list
3. Ask which tool you want to launch (Claude or Codex)
4. Ask which model to use
5. Save the selection to the correct profile
6. Launch the tool with the right environment variables

Or specify the tool directly:
```powershell
node launch.js claude
node launch.js codex
```

**Note:** `launch.js` requires Node.js to be installed.

---

## Using with Claude Code

Once `claude-local.bat` is running:

1. Claude Code starts normally
2. It will show the model name from your `claude` profile
3. Type prompts as usual
4. Claude Code will use tools (read files, search, etc.) through the proxy
5. The proxy translates everything to/from your chosen upstream provider

**To switch models:**
- Option 1: Change the model in the Web UI and click Save, then restart Claude Code
- Option 2: Run `launch.js` again and select a different model

---

## Using with OpenAI Codex

Once `codex-local.bat` is running:

1. Codex starts normally
2. It may show a warning: "Model metadata for `xxx` not found" — this is **harmless**
3. Type prompts as usual
4. Codex will use tools through the proxy

**Known Codex behavior:**
- Codex appends "xhigh" to the model display (this is Codex's reasoning effort setting, not part of the model ID)
- Codex uses the `/v1/responses` API, which the proxy translates to `/v1/chat/completions` for the upstream

**To switch models:**
- Same as Claude — use the Web UI or `launch.js`

---

## Using with Cline / Other Tools

Any tool that supports "OpenAI Compatible" or custom base URLs can use Claudish.

### Cline (VS Code Extension)

1. Open Cline settings in VS Code
2. Set **Provider** to `OpenAI Compatible`
3. Set **Base URL** to `http://localhost:8085`
4. Set **API Key** to any dummy value (e.g., `dummy`)
5. Select a model from the dropdown (Cline fetches from `/v1/models`)

### Continue.dev

1. Open Continue settings
2. Add a custom provider:
   ```json
   {
     "title": "Claudish",
     "provider": "openai",
     "apiBase": "http://localhost:8085",
     "apiKey": "dummy",
     "model": "minimax-m2.5-free"
   }
   ```

### Any Other Tool

Look for settings like:
- "Custom endpoint"
- "Base URL"
- "OpenAI Compatible"
- "API Host"

Set the URL to `http://localhost:8085` and use any dummy API key.

---

## Web UI Guide

Open **http://localhost:8085** in your browser.

### Status Cards (Top Row)

| Card | Shows |
|------|-------|
| **Claude Model** | Currently selected model + provider + context window size |
| **Codex Model** | Currently selected model + provider + context window size |
| **Pending Requests** | Number of in-flight requests |
| **Total Requests** | Total completed requests since startup |

### Profile Panels (Left Column)

Each profile has:
- **Model** dropdown — select from fetched models
- **Target URL** — the upstream API endpoint (auto-filled when you select a model)
- **API Key** — your provider key (auto-filled when you select a model)
- **Context Window** — auto-detected from model ID (shown in green)
- **Save** — persists to `config.json`
- **Test** — sends a test message to verify connectivity

### Active Clients

Shows whether Claude and/or Codex are currently sending requests:
- 🟢 **Active** = traffic in the last 60 seconds
- ⚪ **Idle** = no recent traffic

### Request Traffic (Right Column)

A live table of all requests:
- Time, Client (Claude/Codex), Endpoint, Model, Duration, Status

Click any row to see details in the Request Inspector below.

### Live File Activity

Shows what files the model is reading or searching in real time.

### Request Inspector

Click any request to expand and see:

| Section | Icon | What it shows |
|---------|------|---------------|
| **Model Thinking** | 🤔 | The model's internal reasoning content |
| **Tool Calls** | 🔧 | Tools the model invoked with arguments |
| **Response Content** | 💬 | The actual text the model returned |
| **Errors** | ❌ | Any proxy or upstream errors |
| **Raw JSON** | — | Full request/response for deep debugging |

**How to use it for debugging:**
- If Codex stops responding → look for red ERROR cards
- If responses are truncated → check `finish: length` badge
- If tools aren't executing → check the 🔧 section
- If the model seems confused → read the 🤔 thinking section

### Custom Provider (Below Profiles)

Use any OpenAI-compatible API:

1. Enter **API Base URL** (e.g., `https://api.example.com/v1`)
2. Enter **API Key**
3. Click **🔍 Fetch Models** — populates the dropdown
4. Click **🧪 Test** — verifies the connection works
5. Select a model, click **Apply to Claude** or **Apply to Codex**
6. Click **Save** on the profile to persist

The custom provider URL and key are saved to `config.json` so you don't have to re-enter them.

---

## Custom Provider Setup

You can use **any** provider that implements the OpenAI Chat Completions API.

### Examples

| Provider | Base URL | Notes |
|----------|----------|-------|
| **OpenRouter** | `https://openrouter.ai/api/v1` | Largest free model selection |
| **Together AI** | `https://api.together.xyz/v1` | Good for Llama models |
| **Fireworks** | `https://api.fireworks.ai/inference/v1` | Fast inference |
| **Groq** | `https://api.groq.com/openai/v1` | Very fast, limited models |
| **Local (Ollama)** | `http://localhost:11434/v1` | Run models locally |
| **Local (LM Studio)** | `http://localhost:1234/v1` | GUI for local models |

### Ollama / Local Models

For completely local, free, private AI:

1. **Install Ollama:** https://ollama.com
2. **Pull a model:**
   ```powershell
   ollama pull llama3.1
   ```
3. **Start Ollama server:**
   ```powershell
   ollama serve
   ```
4. **In the Web UI Custom Provider:**
   - Base URL: `http://host.docker.internal:11434/v1`
   - API Key: leave blank
   - Click Fetch Models
   - Select `llama3.1`, apply to a profile, save

> **Note:** When running inside Docker, use `host.docker.internal` to reach the host machine. If the proxy is NOT running in Docker, use `http://localhost:11434/v1`.

### LM Studio

1. **Install LM Studio:** https://lmstudio.ai
2. **Download a model** through the GUI
3. **Start the local server** (button in the GUI)
4. **In the Web UI Custom Provider:**
   - Base URL: `http://host.docker.internal:1234/v1`
   - API Key: leave blank

---

## Advanced Features

### Smart Context Compaction

Instead of always truncating to a fixed number of messages, the proxy:

1. **Detects the model's context window** from its ID (e.g., `256k` → 256,000 tokens)
2. **Estimates token usage** of the full conversation
3. **Only compacts when > 88% of context window** is used
4. **Keeps system messages** and drops oldest non-system messages first
5. **Logs the decision** so you can see when and why it happened

This means small conversations pass through untouched, while long conversations get trimmed intelligently.

### Auto Context Window Detection

The proxy knows the context sizes of 20+ models and can infer from model ID patterns:

| Pattern | Detected Size |
|---------|--------------|
| `*-32k-*` or `*/32k/*` | 32,768 tokens |
| `*-128k-*` or `*/128k/*` | 131,072 tokens |
| `*-256k-*` or `*/256k/*` | 262,144 tokens |
| `*-1m-*` or `*/1m/*` | 1,048,576 tokens |
| `gemini-2.0` | 1,048,576 tokens |
| `llama-3.1` | 131,072 tokens |
| `deepseek` | 64,000 tokens |

Unknown models default to 32,768 tokens (safe fallback).

### Self-Healing

When a tool execution fails, the proxy detects common errors and appends hints:

| Error Pattern | Hint Added |
|---------------|-----------|
| PowerShell in bash | "You used PowerShell commands in a bash shell. Use bash equivalents." |
| Permission denied | "Permission denied — try with elevated privileges or check file ownership." |
| Windows paths in Unix | "You used backslash paths in a unix shell. Use forward slashes." |
| Generic exit codes | "Command failed — do NOT stop, fix and retry." |

This prevents the model from getting stuck on simple environment mismatches.

### Windows Environment Injection

Every request gets this system prompt appended:

```
ENVIRONMENT: You are running on Windows (PowerShell). Use Windows commands and paths.
- Use PowerShell syntax (Get-ChildItem, Select-String) NOT bash (ls, grep).
- Use backslash paths (C:\Users\...) NOT forward slash (/home/...).
- Do NOT suggest bash, sh, zsh, or WSL commands unless explicitly asked.
```

This dramatically reduces the "model suggests Linux commands on Windows" problem.

### Deterministic Tool ID Mapping

Tool call IDs are encoded using base64url so the same OpenAI `call_xxx` ID always maps to the same Anthropic `toolu_xxx` ID across turns. This means:
- Zero shared state between concurrent requests
- No ID collision bugs when Claude + Codex run simultaneously
- Perfect bidirectional translation

---

## Troubleshooting

### Docker won't start

```powershell
# Restart Docker Desktop
Stop-Process -Name "Docker Desktop" -Force
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"

# Wait 30 seconds, then rebuild
docker compose down
docker compose up --build -d
```

### "No models found"

1. Check your `.env` file has the correct API keys
2. Check the Docker logs: `docker logs claudish-proxy --tail 20`
3. Try the **Custom Provider** section with your provider's direct URL
4. Some providers block requests from certain regions — try a VPN

### Codex shows "high demand" or exits immediately

1. Check the proxy logs for errors: `docker logs claudish-proxy -f`
2. Check the **Request Inspector** in the UI for red ERROR cards
3. Try a different model — some free models are unstable
4. Make sure the model ID format matches what your provider expects

### Claude says "model not found" or returns errors

1. Verify the `claude` profile has a valid `targetUrl` and `apiKey`
2. Click **Test** on the Claude profile to verify connectivity
3. Check that the model ID is valid for your provider

### "Model metadata not found" in Codex

This is a harmless warning from Codex itself. Codex has a hardcoded list of OpenAI models and doesn't recognize free-tier model names. It falls back to generic metadata. The proxy handles everything correctly — this warning can be ignored.

### Incomplete responses / model stops mid-sentence

Check the proxy logs for:
```
[Proxy WARNING]: Upstream stopped due to max_tokens limit!
```

This means the model hit its output token limit. The proxy enforces a minimum of 1,024 output tokens, but some free models have low limits. Try:
- A different model with higher output capacity
- Breaking your request into smaller chunks

### Context window too small / history lost

Check the logs for:
```
[Proxy Compaction]: 45K -> 38K tokens (256K window)
```

If compaction happens too aggressively, the model's detected context window might be wrong. You can override it in the UI or config:
```json
{
  "claude": {
    "contextWindow": 128000
  }
}
```

### Port already in use

If port 8085 is taken, change it in `docker-compose.yml`:
```yaml
ports:
  - "8086:8080"  # Use 8086 on host instead
```

Then update your batch files:
```bat
set ANTHROPIC_BASE_URL=http://localhost:8086
```

### Claude Code or Codex can't find the command

Make sure the tools are installed globally:
```powershell
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

Or use `npx`:
```bat
set ANTHROPIC_BASE_URL=http://localhost:8085
npx @anthropic-ai/claude-code
```

---

### 10. URL Normalization

The bridge normalizes incoming URLs to handle client quirks:

```javascript
let cleanPath = originalUrl
    .replace(/^\/v1\/v1\//, '/v1/')        // Fix double /v1/ from some clients
    .replace(/^\/v1\/messages/, '/v1/messages');  // Ensure consistent path
```

**Why this matters:** Some clients occasionally send `/v1/v1/messages` due to base URL concatenation bugs. The proxy silently fixes this.

---

### 11. Retry Logic (Rate Limiting)

The Anthropic adapter retries on HTTP 429 (rate limit) with exponential backoff:

```javascript
let attempts = 0;
while (attempts < 3) {
    response = await fetch(cfg.targetUrl, { ... });
    if (response.status === 429) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
    }
    break;
}
```

This means if a free provider is temporarily overloaded, the proxy automatically retries up to 3 times with 2-second delays before giving up.

---

### 12. Body Parsing Timeout

The OpenAI adapter has a safety timeout for incomplete request bodies:

```javascript
const bodyTimeout = setTimeout(() => {
    if (!bodyComplete) {
        res.writeHead(408);
        res.end('Request Timeout');
    }
}, 30000);
```

If a client disconnects mid-request or the body never arrives, the proxy returns HTTP 408 instead of hanging forever.

---

### 13. Logger & Request Tracking (`utils/logger.js`)

The logger module maintains three in-memory data structures:

#### Activity Log
```javascript
activityLog = [
    { time: '1:52:35 AM', type: 'AGENT', detail: 'Request using minimax-m2.5-free' },
    { time: '1:52:32 AM', type: 'READ', detail: 'README.md' },
    { time: '1:52:29 AM', type: 'SEARCH', detail: 'list_files: .' }
]
```

**Activity types:**
| Type | Trigger | Example |
|------|---------|---------|
| `AGENT` | Request sent to upstream | `Request using minimax-m2.5-free` |
| `READ` | Model reads a file | `README.md` |
| `SEARCH` | Model searches/greps | `list_files: .` |
| `COMPACT` | Context was compacted | `Claude: 45K -> 38K tokens (256K window)` |

Max 50 entries. Oldest are dropped.

#### Request Log
```javascript
requestLog = [
    {
        time: '1:52:35 AM',
        clientType: 'codex',
        endpoint: '/v1/responses',
        model: 'inclusionai/ling-2.6-1t:free',
        status: 'success',
        durationMs: 2340,
        error: null,
        reqId: 'req_1777254757060_e57hr'
    }
]
```

Max 50 entries. Shows in the UI's **Request Traffic** table.

#### Pending Requests Map
```javascript
pendingRequests = Map<reqId, { clientType, endpoint, startTime }>
```

Active in-flight requests. The UI shows the count on the **Pending Requests** status card.

#### Request Inspector Capture
```javascript
requestDetails = Map<reqId, {
    reqId, timestamp, requestBody, responseBody,
    thinking, toolCalls, finishReason, error, status
}>
```

Max 20 entries. Stores full request/response for the **Request Inspector** panel.

**Data sanitization:** API keys are redacted before storage:
```javascript
function sanitizeForDisplay(data) {
    return str.replace(/"(api[_-]?key|authorization|token)"\s*:\s*"[^"]*"/gi, '"$1": "***"');
}
```

---

### 14. Model Registry (`utils/models.js`)

#### KNOWN_MODELS Lookup Table

```javascript
const KNOWN_MODELS = {
  'minimax/minimax-m2.5:free': { inputTokens: 256000, outputTokens: 8192 },
  'google/gemini-2.0-flash-exp:free': { inputTokens: 1048576, outputTokens: 8192 },
  'meta-llama/llama-3.3-70b-instruct:free': { inputTokens: 131072, outputTokens: 8192 },
  'deepseek/deepseek-chat:free': { inputTokens: 64000, outputTokens: 8192 },
  ...
};
```

This table maps model IDs to their known context windows. Both namespaced (`minimax/minimax-m2.5:free`) and shorthand (`minimax-m2.5-free`) IDs are supported.

#### Context Window Detection (5-Tier Fallback)

When a model is selected, the proxy tries 5 strategies in order:

1. **Pattern inference** (fast, no network) — scans the model ID for family patterns:
   ```javascript
   if (id.includes('gemini-2.0')) return { inputTokens: 1048576, outputTokens: 8192 };
   if (id.includes('llama-3.1')) return { inputTokens: 131072, outputTokens: 8192 };
   if (id.includes('deepseek')) return { inputTokens: 64000, outputTokens: 8192 };
   ```

2. **Explicit size in name** — `256k` → 262,144 tokens, `1m` → 1,048,576 tokens:
   ```javascript
   const match = id.match(/[-/](\d+)(k|m)\b/);
   // "minimax-m2.5-256k" → 256 * 1024 = 262,144 input tokens
   ```

3. **API cache** — checks if OpenRouter data was previously fetched

4. **Provider's own `/models` endpoint** — fetches from the upstream's model list

5. **OpenRouter API** — fetches `https://openrouter.ai/api/v1/models` as last resort

6. **Safe default** — 32,768 input / 4,096 output tokens

#### Profile-Based Caching

Detected context windows are saved to `config.json` so they don't need re-detection:
```json
{
  "claude": {
    "currentModel": "minimax-m2.5-free",
    "contextWindow": 256000,
    "contextModelId": "minimax-m2.5-free"
  }
}
```

The `contextModelId` field ensures the cached value is only used for the same model. If you switch models, it re-detects.

---

### 15. Mock Upstream (`mock-upstream.js`)

A local test server that simulates an LLM provider without hitting real APIs. Useful for development and CI.

**What it does:**
- Listens on port `9999`
- Accepts `POST /chat/completions`
- Returns realistic tool calls (`list_files`, `read_file`) on turn 1
- Returns natural language responses on turn 2+
- Supports both streaming and non-streaming
- Adds 100-300ms artificial latency

**How to use:**
```powershell
# Terminal 1: Start mock
node mock-upstream.js

# Terminal 2: Point proxy to mock
# In config.json, set targetUrl to "http://host.docker.internal:9999/v1/chat/completions"
# Or use the Custom Provider panel with http://localhost:9999/v1
```

**Why it exists:** Free-tier providers have rate limits. During development, hitting them repeatedly causes 429 errors. The mock lets you test the full adapter translation pipeline locally.

---

### 16. Test Scripts

#### `test-tool-flow.js`

Tests the complete multi-turn tool flow for both Claude and Codex:

**Claude test:**
1. Turn 1: Send user message → expect `tool_use` (list_files, read_file)
2. Turn 2: Send tool results → expect more `tool_use` or `end_turn`
3. Turn 3: Send more tool results → expect final `end_turn` with text

**Codex test:**
1. Turn 1: Send Responses API request → expect `function_call` output items
2. Turn 2: Send function results → expect final message

**What it validates:**
- Request/response format translation works
- Tool IDs are deterministic across turns
- SSE synthesis for Responses API works
- Multi-turn conversation state is preserved

#### `test-parallel.js`

Runs Claude and Codex tests **simultaneously** to validate concurrent request isolation:

```javascript
await Promise.all([
    testClaudeToolFlow(),
    testCodexToolFlow()
]);
```

**What it validates:**
- No shared state collisions between concurrent clients
- Tool ID mapping doesn't cross-pollute
- Both adapters can handle requests at the same time

---

### 17. Install Scripts (`install-global.bat` / `install-global.ps1`)

Adds the `claudish-proxy` folder to your Windows user PATH so you can run `claude-local`, `codex-local`, and `launch` from any directory.

```powershell
# What install-global.ps1 does:
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$newPath = "$currentPath;$dir"
[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
```

After running, close and reopen your terminal, then type:
```powershell
claude-local   # from anywhere
codex-local    # from anywhere
launch         # from anywhere
```

---

### 18. Docker Configuration Details

#### Dockerfile

```dockerfile
FROM node:20-slim
WORKDIR /app
RUN npm install http-proxy
COPY bridge.js config.json ui.html ./
COPY adapters/ ./adapters/
COPY utils/ ./utils/
EXPOSE 8080
CMD ["node", "bridge.js"]
```

**Why `node:20-slim`:** Small image (~200MB) with Node.js 20 and native `fetch()` support.

**Why `npm install http-proxy`:** Only external dependency. Used by the legacy `adapter.js` (kept for compatibility).

#### docker-compose.yml Critical Fix

```yaml
services:
  claudish-proxy:
    # ...
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: always
    # --- THE CRITICAL FIX ---
    tty: true
    stdin_open: true
```

**`tty: true` and `stdin_open: true`:** These are critical for Node.js containers on some Docker Desktop versions. Without them, the container may exit immediately or fail to handle signals correctly.

**`extra_hosts`:** Ensures `host.docker.internal` resolves correctly on Linux Docker hosts (not needed on Docker Desktop for Windows, but harmless).

**`restart: always`:** Automatically restarts the container if it crashes or if Docker Desktop restarts.

---

### 19. UI Architecture (`ui.html`)

The UI is a **single HTML file** with embedded JavaScript. No build step. No framework (except Tailwind CSS loaded from CDN).

#### Polling System

The UI polls the proxy every 2 seconds for live updates:

```javascript
setInterval(loadActivity, 2000);     // Activity log (SEARCH, READ, AGENT)
setInterval(loadRequests, 2000);     // Request traffic table
setInterval(loadInspector, 2000);    // Request inspector data
```

#### Fallback Models

If the proxy is unreachable on page load, the UI pre-populates with fallback models so it's never empty:

```javascript
const FALLBACK_MODELS = [
    { id: 'minimax-m2.5-free', name: 'minimax-m2.5-free', provider: 'Fallback' },
    { id: 'ling-2.6-flash-free', name: 'ling-2.6-flash-free', provider: 'Fallback' },
    ...
];
```

#### Cline / Agent Configuration Panel

Below the Custom Provider panel, there's a read-only panel showing:
- The Codex profile's target URL
- A note: "Set provider to 'OpenAI Compatible' in Cline settings"

This is for users who want to connect Cline (or Continue.dev, or any other VS Code extension) to the proxy.

---

### 20. The Legacy `adapter.js`

Before the current architecture, there was a simpler proxy (`adapter.js`) that:
- Used `http-proxy` library
- Forwarded everything to a single target
- Only fixed `usage` field names (`prompt_tokens` → `input_tokens`)

This file is kept for reference but is **not used** by the current system. `bridge.js` is the active server.

---

## File Structure

```
claudish-proxy/
├── bridge.js              # Main HTTP server & routing
├── launch.js              # Interactive CLI launcher
├── ui.html                # Web dashboard
├── config.json            # Profile configs (mounted volume)
├── .env                   # API keys (Docker env file)
├── Dockerfile             # Node.js 20-slim image
├── docker-compose.yml     # Docker orchestration
├── claude-local.bat       # Launch Claude through proxy
├── codex-local.bat        # Launch Codex through proxy
├── adapters/
│   ├── anthropic.js       # /v1/messages handler (Claude)
│   └── openai.js          # /v1/chat/completions & /v1/responses handler (Codex)
└── utils/
    ├── config.js          # Config loader with caching
    ├── logger.js          # Activity & request tracking
    ├── models.js          # Model registry & context window detection
    ├── tokens.js          # Token estimation
    └── selfheal.js        # Error detection & fix hints
```

---

## License

MIT — use at your own risk. Free-tier providers may have rate limits, usage caps, and varying availability.
