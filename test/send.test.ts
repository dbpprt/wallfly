import assert from 'node:assert/strict';
import test from 'node:test';
import * as send from '../src/send/index.js';

test('send boundary loads as an empty ESM module offline', () => {
  assert.deepEqual(Object.keys(send), []);
});
