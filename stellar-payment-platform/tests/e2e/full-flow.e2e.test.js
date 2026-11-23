/**
 * Full-flow end-to-end test suite.
 *
 * Covers the complete product journey in sequence:
 *   1. Register a new username via POST /api/v1/register
 *   2. Resolve the registered username via GET /api/v1/federation
 *   3. Create a payment intent via POST /api/v1/payments/intents
 *   4. Simulate webhook delivery and assert the webhook payload
 *
 * ============================================================================
 * ENVIRONMENT SETUP
 * ============================================================================
 *
 * This suite is designed to run against a live local dev stack (not mocked).
 * The following environment variables must be set (see tests/e2e/README.md):
 *
 *   E2E_BASE_URL        Base URL of the running API (default: http://localhost:3000)
 *   E2E_WEBHOOK_URL     URL the payment service delivers webhooks to
 *                       (default: http://localhost:3000/api/v1/webhooks/payment)
 *   E2E_WEBHOOK_SECRET  Shared secret used to sign/verify webhook payloads
 *   E2E_DB_URL          Postgres connection string used by purgeTestRecords
 *                       to clean up records created by this suite
 *   E2E_JWT_SECRET      Secret used to mint the authenticated principal JWT
 *                       (default: dev JWT secret used by the local stack)
 *   E2E_JWT_ISSUER      Expected JWT issuer (default: stellar-payment-platform)
 *   E2E_JWT_AUDIENCE    Expected JWT audience (default: stellar-payment-platform)
 *
 * Prerequisites:
 *   - The dev stack (API, Postgres, payment service) must be running.
 *   - The federation endpoint must be reachable and backed by the same DB
 *     the registration endpoint writes to.
 *   - The webhook receiver must be running and able to accept deliveries.
 *
 * Run with:
 *   npm run test:e2e -- tests/e2e/full-flow.e2e.test.js
 *
 * ============================================================================
 */

'use strict';

const crypto = require('crypto');

const {
  e2ePrefix,
  purgeTestRecords,
  apiRequest,
  waitFor,
} = require('./e2eHelpers');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const WEBHOOK_URL =
  process.env.E2E_WEBHOOK_URL ||
  'http://localhost:3000/api/v1/webhooks/payment';
const WEBHOOK_SECRET = process.env.E2E_WEBHOOK_SECRET || '';
const JWT_SECRET =
  process.env.E2E_JWT_SECRET || 'dev-jwt-secret-change-me';
const JWT_ISSUER = process.env.E2E_JWT_ISSUER || 'stellar-payment-platform';
const JWT_AUDIENCE =
  process.env.E2E_JWT_AUDIENCE || 'stellar-payment-platform';

// Unique prefix so records created by this run can be purged afterwards.
const RUN_PREFIX = e2ePrefix('full-flow');

// Shared state threaded through the sequential steps.
const state = {
  username: `${RUN_PREFIX}-user`,
  publicKey: null,
  federationAddress: null,
  paymentIntentId: null,
  webhookPayload: null,
  // Authenticated principal minted for this run. The API must derive
  // ownership from this token, never from caller-supplied body fields.
  principal: null,
  token: null,
  // A second, unrelated principal used to prove cross-tenant access fails.
  otherPrincipal: null,
  otherToken: null,
};

/**
 * Base64url-encode a Buffer or string (JWT compact serialization).
 */
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Mint an HS256 JWT for the given principal. Mirrors the token shape the
 * API's auth middleware expects: `sub` is the canonical username, and the
 * token is scoped to the payment service audience.
 */
function mintToken(principal) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: principal.username,
    username: principal.username,
    publicKey: principal.publicKey,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload)
  )}`;
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Build a deterministic, valid-looking Stellar public key for the test user.
 * The dev stack accepts any well-formed ed25519 public key string.
 */
function buildTestPublicKey(seed) {
  // G + 55 base32-ish chars. Deterministic per run for traceability.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = 'G';
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < 55; i += 1) {
    hash = (hash * 1103515245 + 12345) >>> 0;
    out += alphabet[hash % alphabet.length];
  }
  return out;
}

describe('Full flow: register -> federation -> payment -> webhook', () => {
  jest.setTimeout(60000);

  beforeAll(() => {
    state.publicKey = buildTestPublicKey(state.username);
    state.principal = {
      username: state.username,
      publicKey: state.publicKey,
    };
    state.token = mintToken(state.principal);

    state.otherPrincipal = {
      username: `${RUN_PREFIX}-other`,
      publicKey: buildTestPublicKey(`${RUN_PREFIX}-other`),
    };
    state.otherToken = mintToken(state.otherPrincipal);
  });

  afterAll(async () => {
    // Purge every record created under this run's prefix.
    await purgeTestRecords(RUN_PREFIX);
  });

  // --------------------------------------------------------------------------
  // Step 1: Register a new user
  // --------------------------------------------------------------------------
  test('step 1: registers a new user via POST /api/v1/register', async () => {
    const res = await apiRequest(BASE_URL, {
      method: 'POST',
      path: '/api/v1/register',
      headers: { Authorization: `Bearer ${state.token}` },
      body: {
        username: state.username,
        publicKey: state.publicKey,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body).toBeDefined();
    expect(res.body.username).toBe(state.username);
    expect(res.body.publicKey).toBe(state.publicKey);
    expect(res.body.federationAddress).toBe(
      `${state.username}*${process.env.E2E_FEDERATION_DOMAIN || 'stellar.local'}`
    );

    state.federationAddress = res.body.federationAddress;
  });

  // --------------------------------------------------------------------------
  // Step 2: Resolve the username via federation
  // --------------------------------------------------------------------------
  test('step 2: resolves the username via GET /api/v1/federation', async () => {
    const res = await apiRequest(BASE_URL, {
      method: 'GET',
      path: '/api/v1/federation',
      query: {
        q: state.username,
        type: 'name',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body.stellar_address).toBe(state.federationAddress);
    expect(res.body.account_id).toBe(state.publicKey);
    expect(res.body.memo_type).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Step 3: Create a payment intent
  // --------------------------------------------------------------------------
  test('step 3: creates a payment intent', async () => {
    const res = await apiRequest(BASE_URL, {
      method: 'POST',
      path: '/api/v1/payments/intents',
      headers: { Authorization: `Bearer ${state.token}` },
      body: {
        amount: '10.0000000',
        asset: 'XLM',
        destination: state.federationAddress,
        memo: `e2e-${RUN_PREFIX}`,
        webhookUrl: WEBHOOK_URL,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body).toBeDefined();
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('pending');
    expect(res.body.amount).toBe('10.0000000');
    expect(res.body.asset).toBe('XLM');
    expect(res.body.destination).toBe(state.federationAddress);
    // Ownership is derived from the authenticated principal, not the body.
    expect(res.body.owner).toBe(state.username);
    expect(res.body.ownerUsername).toBe(state.username);

    state.paymentIntentId = res.body.id;
  });

  // --------------------------------------------------------------------------
  // Step 3a: unauthenticated intent creation is rejected
  // --------------------------------------------------------------------------
  test('step 3a: rejects intent creation without a principal', async () => {
    const res = await apiRequest(BASE_URL, {
      method: 'POST',
      path: '/api/v1/payments/intents',
      body: {
        amount: '1.0000000',
        asset: 'XLM',
        destination: state.federationAddress,
        memo: `e2e-anon-${RUN_PREFIX}`,
        webhookUrl: WEBHOOK_URL,
      },
    });

    expect(res.status).toBe(401);
  });

  // --------------------------------------------------------------------------
  // Step 3b: spoofed identity fields in the body cannot grant ownership
  // --------------------------------------------------------------------------
  test('step 3b: rejects spoofed owner fields in the request body', async () => {
    const res = await apiRequest(BASE_URL, {
      method: 'POST',
      path: '/api/v1/payments/intents',
      headers: { Authorization: `Bearer ${state.otherToken}` },
      body: {
        amount: '1.0000000',
        asset: 'XLM',
        destination: state.federationAddress,
        memo: `e2e-spoof-${RUN_PREFIX}`,
        webhookUrl: WEBHOOK_URL,
        // Caller-supplied identity must not be trusted.
        owner: state.username,
        ownerUsername: state.username,
        username: state.username,
        sourceAccount: state.publicKey,
      },
    });

    // Either the spoofed fields are rejected outright, or they are ignored
    // and ownership is bound to the authenticated principal.
    expect([201, 400, 403]).toContain(res.status);
    if (res.status === 201) {
      expect(res.body.owner).toBe(state.otherPrincipal.username);
      expect(res.body.ownerUsername).toBe(state.otherPrincipal.username);
      expect(res.body.owner).not.toBe(state.username);
    }
  });

  // --------------------------------------------------------------------------
  // Step 3c: another principal cannot read this run's intent
  // --------------------------------------------------------------------------
  test('step 3c: denies cross-principal access to the intent', async () => {
    const res = await apiRequest(BASE_URL, {
      method: 'GET',
      path: `/api/v1/payments/intents/${state.paymentIntentId}`,
      headers: { Authorization: `Bearer ${state.otherToken}` },
    });

    expect([403, 404]).toContain(res.status);
  });

  // --------------------------------------------------------------------------
  // Step 4: Simulate webhook delivery and assert the payload
  // --------------------------------------------------------------------------
  test('step 4: simulates webhook delivery and asserts the payload', async () => {
    // Trigger the payment service to deliver a webhook for the intent.
    const trigger = await apiRequest(BASE_URL, {
      method: 'POST',
      path: `/api/v1/payments/intents/${state.paymentIntentId}/simulate-webhook`,
      headers: { Authorization: `Bearer ${state.token}` },
      body: {
        status: 'completed',
        secret: WEBHOOK_SECRET,
      },
    });

    expect([200, 202]).toContain(trigger.status);

    // Wait for the webhook to be delivered and recorded by the receiver.
    const delivered = await waitFor(
      async () => {
        const res = await apiRequest(BASE_URL, {
          method: 'GET',
          path: '/api/v1/webhooks/payment',
          headers: { Authorization: `Bearer ${state.token}` },
          query: { intentId: state.paymentIntentId },
        });
        if (res.status === 200 && Array.isArray(res.body) && res.body.length > 0) {
          return res.body[res.body.length - 1];
        }
        return null;
      },
      { timeoutMs: 15000, intervalMs: 500 }
    );

    expect(delivered).toBeDefined();
    state.webhookPayload = delivered;

    // Assert the webhook payload fields.
    expect(delivered.event).toBe('payment.completed');
    expect(delivered.intentId).toBe(state.paymentIntentId);
    expect(delivered.status).toBe('completed');
    expect(delivered.amount).toBe('10.0000000');
    expect(delivered.asset).toBe('XLM');
    expect(delivered.destination).toBe(state.federationAddress);
    expect(delivered.memo).toBe(`e2e-${RUN_PREFIX}`);
    expect(delivered.timestamp).toBeDefined();
    expect(typeof delivered.timestamp).toBe('string');
    // The authenticated principal must be carried across the payment
    // service boundary into the webhook payload.
    expect(delivered.owner).toBe(state.username);
    expect(delivered.ownerUsername).toBe(state.username);
    expect(delivered.principal).toBeDefined();
    expect(delivered.principal.username).toBe(state.username);
  });

  // --------------------------------------------------------------------------
  // Final: confirm the intent reflects the completed state
  // --------------------------------------------------------------------------
  test('final: payment intent reflects completed status', async () => {
    const res = await apiRequest(BASE_URL, {
      method: 'GET',
      path: `/api/v1/payments/intents/${state.paymentIntentId}`,
      headers: { Authorization: `Bearer ${state.token}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(state.paymentIntentId);
    expect(res.body.status).toBe('completed');
    expect(res.body.owner).toBe(state.username);
    expect(res.body.ownerUsername).toBe(state.username);
  });

  // --------------------------------------------------------------------------
  // Final: unauthenticated reads of the intent are rejected
  // --------------------------------------------------------------------------
  test('final: rejects unauthenticated intent reads', async () => {
    const res = await apiRequest(BASE_URL, {
      method: 'GET',
      path: `/api/v1/payments/intents/${state.paymentIntentId}`,
    });

    expect(res.status).toBe(401);
  });
});