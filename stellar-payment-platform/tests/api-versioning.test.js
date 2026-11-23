'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

process.env.NODE_ENV = 'test';

const { app } = require('../server');
const { apiVersion, fromUri, fromHeader } = require('../src/middleware/apiVersion');

describe('apiVersion middleware — version resolution', () => {
  const buildProbe = () => {
    const probe = express();
    probe.use(apiVersion);
    probe.use((req, res) => res.json({ apiVersion: req.apiVersion }));
    return probe;
  };

  describe('fromUri', () => {
    test('extracts the version segment from /api/v1 and /api/v2 paths', () => {
      expect(fromUri({ path: '/api/v1/federation' })).toBe('v1');
      expect(fromUri({ path: '/api/v2/federation' })).toBe('v2');
      expect(fromUri({ path: '/api/v1' })).toBe('v1');
    });

    test('returns null for unsupported, unversioned, or non-URL paths', () => {
      expect(fromUri({ path: '/api/v9/federation' })).toBeNull();
      expect(fromUri({ path: '/federation' })).toBeNull();
      expect(fromUri({ path: '/api' })).toBeNull();
    });
  });

  describe('fromHeader', () => {
    test('reads Accept-Version and API-Version headers case-insensitively', () => {
      expect(fromHeader({ get: (k) => (k === 'accept-version' ? 'v2' : null) })).toBe('v2');
      expect(fromHeader({ get: (k) => (k === 'api-version' ? 'V2' : null) })).toBe('v2');
    });

    test('returns null when no header is present or the value is unsupported', () => {
      expect(fromHeader({ get: () => null })).toBeNull();
      expect(fromHeader({ get: () => 'v3' })).toBeNull();
    });
  });

  describe('resolution through the probe app', () => {
    test('URI-based version wins for /api/v1 and /api/v2', async () => {
      const probe = buildProbe();
      const v1 = await request(probe).get('/api/v1/federation');
      const v2 = await request(probe).get('/api/v2/federation');
      expect(v1.body.apiVersion).toBe('v1');
      expect(v2.body.apiVersion).toBe('v2');
    });

    test('defaults to v1 when no version appears in the URI or headers', async () => {
      const res = await request(buildProbe()).get('/federation');
      expect(res.body.apiVersion).toBe('v1');
    });

    test('falls back to the header when the URI carries no version', async () => {
      const probe = buildProbe();
      const viaAccept = await request(probe).get('/federation').set('Accept-Version', 'v2');
      const viaApi = await request(probe).get('/federation').set('API-Version', 'v2');
      expect(viaAccept.body.apiVersion).toBe('v2');
      expect(viaApi.body.apiVersion).toBe('v2');
    });

    test('URI version takes precedence over a contradicting header', async () => {
      const res = await request(buildProbe())
        .get('/api/v1/federation')
        .set('API-Version', 'v2');
      expect(res.body.apiVersion).toBe('v1');
    });
  });
});

describe('API versioning — mounted routers', () => {
  test('/api/v1 and /api (no version) return identical results', async () => {
    const explicit = await request(app)
      .get('/api/v1/federation')
      .query({ q: 'client*localhost' });
    const bare = await request(app)
      .get('/api/federation')
      .query({ q: 'client*localhost' });

    expect(explicit.status).toBe(200);
    expect(bare.status).toBe(explicit.status);
    expect(bare.body).toEqual(explicit.body);
  });

  test('/api/v2 root answers with the v2 banner', async () => {
    const res = await request(app).get('/api/v2/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ apiVersion: 'v2', status: 'ok' });
  });

  test('/api/v2 falls back to the v1 router for endpoints not yet ported', async () => {
    const v2 = await request(app)
      .get('/api/v2/federation')
      .query({ q: 'client*localhost' });
    const v1 = await request(app)
      .get('/api/v1/federation')
      .query({ q: 'client*localhost' });

    expect(v2.status).toBe(200);
    expect(v2.status).toBe(v1.status);
    expect(v2.body).toEqual(v1.body);
  });

  test('an unknown version segment returns 404', async () => {
    const res = await request(app)
      .get('/api/v9/federation')
      .query({ q: 'client*localhost' });
    expect(res.status).toBe(404);
  });
});

describe('API versioning — published client contracts', () => {
  const fs = require('fs');
  const path = require('path');
  const { SUPPORTED_VERSIONS, DEPRECATIONS, getDeprecation } = require('../src/config/deprecations');

  const CONTRACTS_ROOT = path.join(__dirname, 'contracts', 'clients');

  const loadFixtures = (version) => {
    const dir = path.join(CONTRACTS_ROOT, version);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };

  const pick = (obj, keys) => {
    if (!obj) return obj;
    return keys.reduce((acc, k) => {
      if (Object.prototype.hasOwnProperty.call(obj, k)) acc[k] = obj[k];
      return acc;
    }, {});
  };

  const diff = (expected, actual, at = '$') => {
    const out = [];
    if (expected === actual) return out;
    const bothObjects =
      expected && actual && typeof expected === 'object' && typeof actual === 'object';
    if (!bothObjects) {
      out.push(`${at}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      return out;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const next = `${at}.${key}`;
      if (!(key in expected)) {
        out.push(`${next}: unexpected field ${JSON.stringify(actual[key])}`);
      } else if (!(key in actual)) {
        out.push(`${next}: missing field (expected ${JSON.stringify(expected[key])})`);
      } else {
        out.push(...diff(expected[key], actual[key], next));
      }
    }
    return out;
  };

  const replay = async (fixture) => {
    let req = request(app)[fixture.request.method.toLowerCase()](fixture.request.path);
    if (fixture.request.query) req = req.query(fixture.request.query);
    for (const [k, v] of Object.entries(fixture.request.headers || {})) {
      req = req.set(k, v);
    }
    return req;
  };

  test('every supported version has at least one published contract', () => {
    for (const version of SUPPORTED_VERSIONS) {
      expect(loadFixtures(version).length).toBeGreaterThan(0);
    }
  });

  for (const version of SUPPORTED_VERSIONS) {
    describe(`${version} client contracts`, () => {
      const fixtures = loadFixtures(version);

      for (const fixture of fixtures) {
        test(`${fixture.name}`, async () => {
          const res = await replay(fixture);

          expect(res.status).toBe(fixture.expect.status);

          if (fixture.expect.headers) {
            const actualHeaders = pick(res.headers, Object.keys(fixture.expect.headers));
            const headerDiff = diff(fixture.expect.headers, actualHeaders, '$headers');
            if (headerDiff.length) {
              throw new Error(`Header contract mismatch:\n${headerDiff.join('\n')}`);
            }
          }

          if (fixture.expect.body !== undefined) {
            const bodyDiff = diff(fixture.expect.body, res.body, '$body');
            if (bodyDiff.length) {
              throw new Error(`Body contract mismatch:\n${bodyDiff.join('\n')}`);
            }
          }
        });
      }
    });
  }

  test('unknown version (v9) is rejected with 404 and no contract leak', async () => {
    const res = await request(app).get('/api/v9/federation').query({ q: 'client*localhost' });
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('apiVersion', 'v9');
  });

  test('URI version takes precedence over a contradicting header', async () => {
    const res = await request(app)
      .get('/api/v1/federation')
      .set('API-Version', 'v2')
      .query({ q: 'client*localhost' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      (await request(app).get('/api/v1/federation').query({ q: 'client*localhost' })).body
    );
  });

  test('header-only version is honoured when URI is unversioned', async () => {
    const viaHeader = await request(app)
      .get('/federation')
      .set('Accept-Version', 'v2')
      .query({ q: 'client*localhost' });
    const viaUri = await request(app)
      .get('/api/v2/federation')
      .query({ q: 'client*localhost' });
    expect(viaHeader.status).toBe(viaUri.status);
    expect(viaHeader.body).toEqual(viaUri.body);
  });

  test('deprecation config exposes a sunset window for every deprecated version', () => {
    for (const [version, entry] of Object.entries(DEPRECATIONS)) {
      expect(SUPPORTED_VERSIONS).toContain(version);
      expect(entry.sunset).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(new Date(entry.sunset).getTime()).toBeGreaterThan(Date.now());
      expect(getDeprecation(version)).toEqual(entry);
    }
  });

  test('deprecated versions emit Deprecation and Sunset headers', async () => {
    const deprecated = Object.keys(DEPRECATIONS);
    if (deprecated.length === 0) return;
    for (const version of deprecated) {
      const res = await request(app)
        .get(`/api/${version}/federation`)
        .query({ q: 'client*localhost' });
      expect(res.headers.deprecation).toBeDefined();
      expect(res.headers.sunset).toBeDefined();
      expect(new Date(res.headers.sunset).getTime()).toBe(
        new Date(DEPRECATIONS[version].sunset).getTime()
      );
    }
  });
});