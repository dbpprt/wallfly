import assert from 'node:assert/strict';
import test from 'node:test';
import * as cli from '../src/cli/index.js';

test('CLI boundary loads as an empty ESM module offline', () => {
  assert.deepEqual(Object.keys(cli), []);
});
