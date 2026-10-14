import assert from 'node:assert/strict';
import test from 'node:test';
import * as store from '../src/store/index.js';

test('store boundary loads as an empty ESM module offline', () => {
  assert.deepEqual(Object.keys(store), []);
});
