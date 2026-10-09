'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSemver, isValidVersion, compareSemver, sortVersions, maxVersion } = require('../../src/kernel/versions');

describe('versions (semver, no ranges)', () => {
  it('validates strictly', () => {
    assert.equal(isValidVersion('1.0.0'), true);
    assert.equal(isValidVersion('0.0.1'), true);
    assert.equal(isValidVersion('10.20.30-rc.1'), true);
    for (const bad of ['1.0', 'v1.0.0', '1.0.0-', '01.0.0', '', 'latest', '^1.0.0', '>=1', null, 7]) {
      assert.equal(isValidVersion(bad), false, String(bad));
    }
  });

  it('compares precedence incl. prereleases', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
    assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
    assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0'), -1);
    assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
    assert.equal(compareSemver('1.0.0-2', '1.0.0-10'), -1);
    assert.throws(() => compareSemver('nope', '1.0.0'), /invalid semver/);
  });

  it('sorts and picks max (semver-aware, not lexicographic)', () => {
    assert.deepEqual(sortVersions(['1.10.0', '1.9.0', '1.9.1']), ['1.9.0', '1.9.1', '1.10.0']);
    assert.equal(maxVersion(['1.0.0', '2.0.0-rc.1', '2.0.0']), '2.0.0');
    assert.equal(maxVersion([]), null);
  });
});
