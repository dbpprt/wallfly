import assert from 'node:assert/strict';
import test from 'node:test';
import * as daemon from '../src/daemon/index.js';

test('daemon boundary loads as an empty ESM module offline', () => {
  assert.deepEqual(Object.keys(daemon), []);
});
