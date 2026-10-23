import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newerThan, updateNotice } from './appVersion';

test('version comparison', () => {
  assert.equal(newerThan('1.0.2', '1.0.1'), true);
  assert.equal(newerThan('1.1.0', '1.0.9'), true);
  assert.equal(newerThan('1.0.1', '1.0.1'), false);
  assert.equal(newerThan('1.0.0', '1.0.1'), false);
  assert.equal(newerThan('1.0.10', '1.0.9'), true, 'numeric, not text');
  assert.equal(newerThan('evil', '1.0.1'), false);
  assert.equal(newerThan(null, '1.0.1'), false);
});

test('update notices', () => {
  assert.equal(updateNotice(undefined, '1.0.2'), null);
  assert.equal(updateNotice({ latest: '1.0.2', min: null }, '1.0.2'), null);
  assert.deepEqual(updateNotice({ latest: '1.0.3', min: null }, '1.0.2'), { required: false, version: '1.0.3' });
  assert.deepEqual(updateNotice({ latest: '1.0.3', min: '1.0.2' }, '1.0.1'), { required: true, version: '1.0.3' });
  assert.deepEqual(updateNotice({ latest: null, min: '1.0.2' }, '1.0.1'), { required: true, version: '1.0.2' });
});
