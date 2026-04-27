// ── Self-healing: detect common tool errors and add hints so the model can fix them ──

const PS_CMDLETS = [
    'Get-ChildItem', 'Select-Object', 'Where-Object', 'Get-Content',
    'Write-Host', 'Set-Location', 'Get-Location', 'Test-Path',
    'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item',
    'Out-File', 'Format-Table', 'Format-List', 'ForEach-Object',
    'Sort-Object', 'Measure-Object', 'Group-Object', 'Compare-Object',
    'Invoke-Expression', 'Start-Process', 'Get-Process', 'Stop-Process'
];

function detectError(content) {
    if (!content || typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    return (
        lower.includes('error:') ||
        lower.includes('exit code') ||
        lower.includes('command not found') ||
        lower.includes('not found') ||
        lower.includes('no such file or directory') ||
        lower.includes('permission denied') ||
        lower.includes('syntax error') ||
        lower.includes('unknown command')
    );
}

function buildHints(content) {
    const hints = [];

    // PowerShell-in-bash detection
    const foundPs = PS_CMDLETS.filter(cmd => content.includes(cmd));
    if (foundPs.length > 0) {
        const equivalents = {
            'Get-ChildItem': 'ls, find, tree',
            'Select-Object': 'cut, awk, grep',
            'Where-Object': 'grep, awk',
            'Get-Content': 'cat, less, head, tail',
            'Write-Host': 'echo, printf',
            'Set-Location': 'cd',
            'Get-Location': 'pwd',
            'Test-Path': 'test -e, [ -f ]',
            'New-Item': 'mkdir, touch',
            'Remove-Item': 'rm, rmdir',
            'Copy-Item': 'cp',
            'Move-Item': 'mv',
            'Out-File': '>, tee',
            'Format-Table': 'column, printf',
            'Format-List': 'cat with formatting',
            'ForEach-Object': 'for, xargs',
            'Sort-Object': 'sort',
            'Measure-Object': 'wc',
            'Group-Object': 'sort | uniq -c',
            'Compare-Object': 'diff, comm',
            'Invoke-Expression': 'eval, source',
            'Start-Process': 'nohup, &, bg',
            'Get-Process': 'ps',
            'Stop-Process': 'kill, pkill'
        };
        const replacements = foundPs.map(c => `${c} → ${equivalents[c] || 'bash equivalent'}`).join(', ');
        hints.push(`[Proxy Self-Heal]: You used PowerShell commands (${foundPs.join(', ')}) in a bash/unix shell. Use bash equivalents instead: ${replacements}. Do NOT stop — fix the command and try again.`);
    }

    // Windows path separators
    if (/\\[a-zA-Z]/.test(content) && !content.includes('/')) {
        hints.push(`[Proxy Self-Heal]: You may be using Windows-style backslash paths in a unix shell. Use forward slashes / instead.`);
    }

    // Command not found with no PowerShell match
    if (content.includes('command not found') && foundPs.length === 0) {
        hints.push(`[Proxy Self-Heal]: The command was not found. Check the command name, ensure it is installed, or use an alternative standard unix tool. Do NOT stop — fix the command and try again.`);
    }

    // Generic permission denied
    if (content.includes('Permission denied')) {
        hints.push(`[Proxy Self-Heal]: Permission denied. Try using sudo, checking file permissions with ls -la, or writing to a different directory. Do NOT stop — fix the command and try again.`);
    }

    // Generic catch-all for any other error
    if (hints.length === 0) {
        hints.push(`[Proxy Self-Heal]: The previous command failed. Read the error carefully, fix the issue, and retry with a corrected command. Do NOT stop — keep trying until it works.`);
    }

    return hints;
}

function enhanceToolResult(content) {
    if (!detectError(content)) return content;

    const hints = buildHints(content);
    const hintBlock = '\n\n' + hints.join('\n');

    return content + hintBlock;
}

function applySelfHealToMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    messages.forEach(m => {
        if (m.role === 'tool' && typeof m.content === 'string') {
            m.content = enhanceToolResult(m.content);
        }
    });
    return messages;
}

module.exports = { enhanceToolResult, applySelfHealToMessages };
