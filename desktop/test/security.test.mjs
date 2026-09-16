import test from 'node:test';
import assert from 'node:assert/strict';
import { allowPermission, isAppNavigation } from '../src/security.mjs';

const origin = 'http://127.0.0.1:5176';
test('app navigation excludes local file API responses and remote content', () => {
  assert.equal(isAppNavigation(`${origin}/agents/example`, origin), true);
  for (const url of [`${origin}/api/file?path=test`, `${origin}/api`, `${origin}/ws/terminal/x`, 'https://example.com', 'file:///tmp/x', 'javascript:alert(1)']) {
    assert.equal(isAppNavigation(url, origin), false);
  }
});
test('only sanitized clipboard writes from the app receive permission', () => {
  assert.equal(allowPermission('clipboard-sanitized-write', `${origin}/`, origin), true);
  for (const permission of ['clipboard-read', 'media', 'geolocation', 'notifications']) {
    assert.equal(allowPermission(permission, origin, origin), false);
  }
  assert.equal(allowPermission('clipboard-sanitized-write', 'https://example.com', origin), false);
  assert.equal(allowPermission('clipboard-sanitized-write', `${origin}/api/file`, origin), false);
});
