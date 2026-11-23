'use strict';

/**
 * Registry of deprecated API paths.
 *
 * Each entry maps a deprecated route prefix to metadata describing the
 * deprecation. `sunsetDate` is the date after which the route will no longer
 * be available (RFC 8594). It may be a Date instance or an ISO 8601 string.
 *
 * Every entry also carries an `owner` (the team responsible for the route)
 * so the backward-compatibility suite can assert deprecation windows and the
 * generated docs can reference the responsible party.
 */
const deprecations = {
  '/api/v1/users': {
    deprecatedAt: '2024-01-01T00:00:00.000Z',
    sunsetDate: '2025-01-01T00:00:00.000Z',
    replacement: '/api/v2/users',
    owner: 'identity-team',
  },
  '/api/v1/orders': {
    deprecatedAt: '2024-03-01T00:00:00.000Z',
    sunsetDate: '2025-03-01T00:00:00.000Z',
    replacement: '/api/v2/orders',
    owner: 'commerce-team',
  },
  '/api/v1/products': {
    deprecatedAt: '2024-06-01T00:00:00.000Z',
    sunsetDate: '2025-06-01T00:00:00.000Z',
    replacement: '/api/v2/products',
    owner: 'catalog-team',
  },
  '/api/v1/accounts': {
    deprecatedAt: '2024-02-01T00:00:00.000Z',
    sunsetDate: '2025-02-01T00:00:00.000Z',
    replacement: '/api/v2/accounts',
    owner: 'identity-team',
  },
  '/api/v1/payments': {
    deprecatedAt: '2024-04-01T00:00:00.000Z',
    sunsetDate: '2025-04-01T00:00:00.000Z',
    replacement: '/api/v2/payments',
    owner: 'payments-team',
  },
  '/api/v1/invoices': {
    deprecatedAt: '2024-05-01T00:00:00.000Z',
    sunsetDate: '2025-05-01T00:00:00.000Z',
    replacement: '/api/v2/invoices',
    owner: 'payments-team',
  },
  '/api/v1/carts': {
    deprecatedAt: '2024-07-01T00:00:00.000Z',
    sunsetDate: '2025-07-01T00:00:00.000Z',
    replacement: '/api/v2/carts',
    owner: 'commerce-team',
  },
  '/api/v1/inventory': {
    deprecatedAt: '2024-08-01T00:00:00.000Z',
    sunsetDate: '2025-08-01T00:00:00.000Z',
    replacement: '/api/v2/inventory',
    owner: 'catalog-team',
  },
};

module.exports = deprecations;