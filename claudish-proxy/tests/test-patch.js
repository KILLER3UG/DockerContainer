const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fuzzyFindAndReplace } = require('../src/utils/fuzzy-match');
const { parseV4APatch, applyV4AOperations } = require('../src/utils/patch-parser');

(async () => {
    // 1. Test Fuzzy Match
    console.log('Testing fuzzy match...');
    const originalText = `line 1
line 2
some code here;
line 4`;

    const searchPattern = `line 2
some code here;`;

    const replacement = `line 2 updated
new code here;`;

    const [newContent, count, strategy, error] = fuzzyFindAndReplace(originalText, searchPattern, replacement, false);
    assert.strictEqual(count, 1);
    assert.strictEqual(error, null);
    assert.ok(newContent.includes('new code here;'));

    // Test whitespace-drift strategy
    const driftedOriginal = `line 1
  line 2 
    some code here;   
line 4`;
    const [driftedContent, dCount, dStrategy, dError] = fuzzyFindAndReplace(driftedOriginal, searchPattern, replacement, false);
    assert.strictEqual(dCount, 1);
    assert.strictEqual(dError, null);
    assert.ok(driftedContent.includes('new code here;'));

    // 2. Test V4A Patch Parser & Apply
    console.log('Testing V4A patch parser and apply...');
    const tempFilePath = path.join(__dirname, 'temp_test_patch.txt');
    fs.writeFileSync(tempFilePath, `Hello World\nThis is a file.\nGoodbye World\n`, 'utf8');

    const patchContent = `
*** Begin Patch
*** Update File: ${tempFilePath}
@@ This is a file. @@
 This is a file.
-Goodbye World
+Goodbye Universe
*** End Patch
`;

    const parsed = parseV4APatch(patchContent);
    assert.strictEqual(parsed.error, null);
    assert.strictEqual(parsed.operations.length, 1);
    assert.strictEqual(parsed.operations[0].operation, 'update');

    const fileOps = {
        read_file_raw(p) {
            if (!fs.existsSync(p)) return { error: 'Not found' };
            return { content: fs.readFileSync(p, 'utf8'), error: null };
        },
        write_file(p, content) {
            fs.writeFileSync(p, content, 'utf8');
            return { error: null };
        },
        delete_file(p) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
            return { error: null };
        },
        move_file(p, np) {
            fs.renameSync(p, np);
            return { error: null };
        }
    };

    const applyResult = applyV4AOperations(parsed.operations, fileOps);
    assert.strictEqual(applyResult.success, true);
    const updatedContent = fs.readFileSync(tempFilePath, 'utf8');
    assert.ok(updatedContent.includes('Goodbye Universe'));
    assert.ok(!updatedContent.includes('Goodbye World'));

    // Clean up
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

    console.log('SUCCESS patch tests');
})();
