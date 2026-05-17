const assert = require('assert');
const {
    extractPathsFromCommand,
    hasParentTraversal,
    checkPathPermission,
    checkCommandPaths,
    ALLOWED_BASE_PATHS
} = require('../src/utils/path-permissions');

(async () => {
    // ── extractPathsFromCommand ──
    assert.deepStrictEqual(extractPathsFromCommand(null), []);
    assert.deepStrictEqual(extractPathsFromCommand(''), []);
    assert.deepStrictEqual(extractPathsFromCommand('echo hello'), [], 'no paths');
    assert.deepStrictEqual(extractPathsFromCommand(123), [], 'non-string');

    const winResult = extractPathsFromCommand('ls C:\\Users\\rober\\LocalFolders\\test');
    assert(winResult.some(p => p.startsWith('C:\\Users')), 'should find Windows paths');

    const unixResult = extractPathsFromCommand('cat /home/user/file.txt');
    assert(unixResult.some(p => p.startsWith('/home/')), 'should find Unix paths');

    // ── hasParentTraversal ──
    assert.strictEqual(hasParentTraversal('..\\escape'), true, 'detects ..\\');
    assert.strictEqual(hasParentTraversal('../escape'), true, 'detects ../');
    assert.strictEqual(hasParentTraversal('cmd ..\\folder'), true, 'detects embedded ..\\');
    assert.strictEqual(hasParentTraversal('cmd ../folder'), true, 'detects embedded ../');
    assert.strictEqual(hasParentTraversal('echo hello'), false, 'no traversal');
    assert.strictEqual(hasParentTraversal(''), false, 'empty string');

    // ── checkPathPermission ──
    const allowedResult = checkPathPermission(ALLOWED_BASE_PATHS[0]);
    assert.strictEqual(allowedResult, null, 'allowed base path');

    const subDir = ALLOWED_BASE_PATHS[0] + '\\subdir\\file.txt';
    const subResult = checkPathPermission(subDir);
    assert.strictEqual(subResult, null, 'subdirectory inside allowed path');

    const blockedResult = checkPathPermission('C:\\Windows\\System32');
    assert(blockedResult, 'path outside workspace should be blocked');
    assert(blockedResult.includes('Permission Denied'), 'block message includes Permission Denied');
    assert(blockedResult.includes(ALLOWED_BASE_PATHS[0]), 'block message includes permitted roots');

    // ── checkCommandPaths ──
    const traversalBlock = checkCommandPaths('cat ../secret.txt');
    assert(traversalBlock.includes('Permission Denied'), 'traversal blocked');
    assert(traversalBlock.includes('..'), 'traversal message mentions ..');

    const safeCommand = checkCommandPaths('dir C:\\Users\\rober\\LocalFolders\\test');
    assert.strictEqual(safeCommand, null, 'safe command should pass');

    const unsafeCommand = checkCommandPaths('dir C:\\Windows\\System32');
    assert(unsafeCommand, 'unsafe command should be blocked');
    assert(unsafeCommand.includes('Permission Denied'), 'unsafe blocks with Permission Denied');

    console.log('SUCCESS path-permissions');
})();
