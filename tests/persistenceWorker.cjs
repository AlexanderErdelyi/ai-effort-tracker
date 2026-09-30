const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get() {} }) },
    window: { showWarningMessage() {} }
  };
  return load.call(this, name, ...args);
};
const { Database } = require('../out/store/database');
const { withStoreLock } = require('../out/store/persistence');
const [directory, name] = process.argv.slice(2);
if (name === 'crash') {
  withStoreLock(path.join(directory, 'effort-tracker.json'), 5000, () => process.exit(0));
} else {
  const db = new Database(directory);
  process.stdout.write('ready\n');
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(path.join(directory, 'go'))) Atomics.wait(buffer, 0, 0, 10);
  for (let i = 0; i < 15; i++) {
    db.recordTime('shared', 'humanCoding', 100);
    db.recordTime(name, 'aiGenerating', 10);
    db.flushSync();
  }
}
