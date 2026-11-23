'use strict';

const { findDeprecation } = require('../../src/middleware/deprecation');

describe('findDeprecation', () => {
  test('ignores header-only entries while matching deprecated endpoints', () => {
    const registry = [
      { kind: 'header', header: 'X-Legacy-Signature' },
      { method: 'GET', path: '/api/v1/lookup' },
    ];

    expect(findDeprecation('GET', '/api/v1/lookup', registry)).toBe(
      registry[1],
    );
    expect(findDeprecation('POST', '/api/v1/lookup', registry)).toBeNull();
  });
});
