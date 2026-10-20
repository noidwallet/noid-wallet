import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, isAllowedServerUrl } from './api';

test('server URLs: https anywhere, http only to a private IP on your network', () => {
  assert.equal(isAllowedServerUrl('https://api.noidusa.com'), true);
  assert.equal(isAllowedServerUrl('http://192.168.1.123:8787'), true);
  assert.equal(isAllowedServerUrl('http://10.0.0.5:8787/'), true);
  assert.equal(isAllowedServerUrl('http://localhost:8787'), true);
  assert.equal(isAllowedServerUrl('http://api.noidusa.com'), false);
  assert.equal(isAllowedServerUrl('http://127.0.0.1@evil.com'), false, 'no user@host tricks');
  assert.equal(isAllowedServerUrl('http://10.evil.com'), false, 'private ranges must be real IPs');
  assert.equal(isAllowedServerUrl('http://192.168.1.999'), false);
  assert.equal(isAllowedServerUrl('ftp://192.168.1.1'), false);
});

test('only known server refusals count as definitely not sent', () => {
  assert.equal(new ApiError('inputs_spent', 'x', 422).ambiguous, false);
  assert.equal(new ApiError('bad_request', 'x', 400).ambiguous, false);
  assert.equal(new ApiError('http_error', 'x', 404).ambiguous, true, 'a proxy 404 might have forwarded it');
  assert.equal(new ApiError('offline', 'x', 0).ambiguous, true);
  assert.equal(new ApiError('unknown_status', 'x', 503).ambiguous, true);
});
