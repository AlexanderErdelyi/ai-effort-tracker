// Runs every tests/*.test.cjs with the built-in node test runner.
// Expands the file list here so it works the same in every shell (no glob support needed).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'tests');
const filter = process.argv[2];
const files = fs.readdirSync(dir)
    .filter(name => name.endsWith('.test.cjs'))
    .filter(name => !filter || name.includes(filter))
    .sort()
    .map(name => path.join(dir, name));

if (files.length === 0) {
    console.error('No test files found' + (filter ? ' matching "' + filter + '"' : ''));
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
