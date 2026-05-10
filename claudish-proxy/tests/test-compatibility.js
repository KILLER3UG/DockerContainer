const assert = require('assert');
const {
    createHostFilesFolder,
    getCompatibilityStatus,
    getHostFilesInfo
} = require('../src/utils/compatibility');

const info = getHostFilesInfo();
assert(info.hostPath.includes('host_files'), 'host_files host path missing');
assert.strictEqual(info.containerPath, '/app/host_files', 'container host_files path mismatch');

const folder = createHostFilesFolder('Unit Test Dropzone');
assert.strictEqual(folder.name, 'Unit-Test-Dropzone', 'folder name should sanitize');
assert(folder.hostPath.endsWith('host_files\\Unit-Test-Dropzone'), 'folder host path mismatch');

const status = getCompatibilityStatus();
assert.strictEqual(status.claudeDesktopPluginRestriction.status, 'client-restricted', 'Claude plugin restriction status missing');
assert(status.families.some(family => family.name === 'Cowork compatibility'), 'Cowork compatibility family missing');
assert(status.families.some(family => family.name === 'Proxy plugins'), 'Proxy plugins family missing');

console.log('SUCCESS compatibility');
