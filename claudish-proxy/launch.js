const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const path = require('path');
const { saveProfile } = require('./utils/config');

const PROXY_URL = 'http://localhost:8085';
const IS_TTY = process.stdin.isTTY;

function question(prompt) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

async function fetchModels() {
    return new Promise((resolve, reject) => {
        const req = http.get(`${PROXY_URL}/ui/models`, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const models = JSON.parse(data);
                    resolve(Array.isArray(models) ? models : []);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

function updateConfig(tool, model) {
    try {
        saveProfile(tool, {
            currentModel: model.id,
            targetUrl: model.url,
            apiKey: model.key || ''
        });
        console.log(`[launch] Set ${tool} model -> "${model.id}"`);
        console.log(`[launch] Set ${tool} provider -> "${model.provider}" (${model.url})`);
    } catch (e) {
        console.error('[launch] Warning: Could not update config.json:', e.message);
    }
}

async function main() {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║      Claudish Proxy Launcher         ║');
    console.log('║   (Ollama launch-style wrapper)      ║');
    console.log('╚══════════════════════════════════════╝\n');

    let tool = process.argv[2];
    if (!tool || (tool !== 'claude' && tool !== 'codex')) {
        if (!IS_TTY) {
            console.log('[launch] Non-interactive mode. Use: launch.js [claude|codex] [args]');
            process.exit(1);
        }
        console.log('Select integration:');
        console.log('  [1] Claude Code  (Anthropic API)');
        console.log('  [2] Codex        (OpenAI API)');
        const choice = await question('\nEnter choice: ');
        tool = choice.trim() === '2' ? 'codex' : 'claude';
    }

    console.log(`\n[launch] Fetching models from ${PROXY_URL}...`);
    let models = [];
    try {
        models = await fetchModels();
    } catch (e) {
        console.log(`[launch] Proxy unreachable (${e.message}). Using fallback.`);
    }

    let selectedModel = null;

    if (models.length > 0) {
        console.log(`\n┌─ Available Models (${models.length}) ─┐`);
        models.forEach((m, i) => {
            const label = m.name || m.id;
            console.log(`  [${(i + 1).toString().padStart(2)}] ${label}`);
        });
        console.log(`  [ 0] Keep current model from config.json`);
        console.log('└─────────────────────────────────────┘');

        let choice;
        if (IS_TTY) {
            choice = await question('\nSelect model (number): ');
        } else {
            choice = '0';
            console.log('[launch] Non-interactive: auto-selecting current model (0)');
        }
        const idx = parseInt(choice.trim()) - 1;
        if (idx >= 0 && idx < models.length) {
            selectedModel = models[idx];
            updateConfig(tool, selectedModel);
        }
    } else {
        console.log('[launch] No models fetched. Using current config.json model.');
    }

    console.log(`\n[launch] Starting ${tool.toUpperCase()}...\n`);

    const env = { ...process.env };
    const extraArgs = process.argv.slice(3);
    let args = [];

    if (tool === 'claude') {
        env.ANTHROPIC_BASE_URL = `${PROXY_URL}/v1`;
        env.ANTHROPIC_API_KEY = 'lm-studio';
        env.ANTHROPIC_AUTH_TOKEN = 'lm-studio';
        args = ['--model', selectedModel?.id || 'claude-sonnet-4-6', ...extraArgs];
    } else {
        env.OPENAI_API_KEY = 'local-proxy';
        args = [
            '--oss',
            '--local-provider', 'openai-custom',
            '-c', 'model_providers.openai-custom.base_url=' + PROXY_URL + '/v1',
            '-c', 'model_providers.openai-custom.name=Proxy'
        ];
        if (selectedModel) {
            args.push('-m', selectedModel.id);
        }
        args.push(...extraArgs);
    }

    const child = spawn(tool, args, {
        stdio: 'inherit',
        env,
        shell: true,
        windowsHide: false
    });

    child.on('error', (err) => {
        console.error(`\n[launch] Failed to start ${tool}: ${err.message}`);
        if (err.code === 'ENOENT') {
            console.error(`         Is "${tool}" installed and on your PATH?`);
            console.error(`         npm install -g @anthropic-ai/claude-code   # for claude`);
            console.error(`         npm install -g @openai/codex              # for codex`);
        }
        process.exit(1);
    });

    child.on('exit', (code) => {
        process.exit(code || 0);
    });
}

main().catch(e => {
    console.error('[launch] Error:', e);
    process.exit(1);
});
