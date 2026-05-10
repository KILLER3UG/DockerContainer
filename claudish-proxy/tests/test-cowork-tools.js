const assert = require('assert');
process.env.NODE_ENV = 'test';
const {
    executeCoworkToolCall,
    getCoworkToolDefinitions,
    isCoworkToolName,
    resolveCoworkPath
} = require('../src/utils/cowork-tools');

(async () => {
    const tools = getCoworkToolDefinitions();
    const names = tools.map(tool => tool.function.name);

    [
        'mcp__cowork__request_cowork_directory',
        'mcp__cowork__present_files',
        'mcp__cowork__save_skill',
        'mcp__cowork__import_capability_link',
        'mcp__cowork__read_widget_context',
        'mcp__cowork__allow_cowork_file_delete'
    ].forEach(name => {
        assert(names.includes(name), `missing Cowork tool definition: ${name}`);
        assert(isCoworkToolName(name), `not recognized as Cowork tool: ${name}`);
    });

    const mapped = resolveCoworkPath('C:\\Users\\rober\\LocalFolders\\DockerContainer\\claudish-proxy\\host_files');
    assert.strictEqual(mapped.allowed, true, 'host_files mapping should be allowed');
    assert.strictEqual(mapped.localPath, '/app/host_files', 'host_files should map to container root');

    const directory = await executeCoworkToolCall('mcp__cowork__request_cowork_directory', {
        path: '/app/host_files',
        reason: 'test'
    });
    assert.strictEqual(directory.status, 'granted', 'mounted Cowork directory should be granted');

    const blockedDelete = await executeCoworkToolCall('mcp__cowork__allow_cowork_file_delete', {
        path: '/etc/passwd'
    });
    assert.strictEqual(blockedDelete.status, 'blocked', 'unsafe delete path should be blocked');

    const widget = await executeCoworkToolCall('mcp__cowork__read_widget_context', {});
    assert.strictEqual(widget.status, 'available', 'widget context fallback should be available');
    assert(widget.memory, 'widget context should include August memory by default');

    console.log('SUCCESS cowork-tools');
})();
