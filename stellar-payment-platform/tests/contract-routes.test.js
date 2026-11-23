'use strict';

/**
 * Unit tests for src/routes/v1/contractRoutes.js.
 */

const request = require('supertest');
const express = require('express');

const mockGetContractStatus = jest.fn();
const mockUpgradeContract = jest.fn();
jest.mock('../src/services/contractService', () => ({
  getContractStatus: (...args) => mockGetContractStatus(...args),
  upgradeContract: (...args) => mockUpgradeContract(...args),
}));

const mockRequirePermission = jest.fn();
jest.mock('../src/middleware/rbac', () => ({
  requirePermission: (...args) => mockRequirePermission(...args),
}));

const mockVerifyStepUp = jest.fn();
jest.mock('../src/services/stepUpService', () => ({
  verifyStepUp: (...args) => mockVerifyStepUp(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock('../src/services/auditService', () => ({
  recordAudit: (...args) => mockRecordAudit(...args),
}));

const contractRoutes = require('../src/routes/v1/contractRoutes');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(contractRoutes);
  return app;
};

describe('GET /contract/status', () => {
  beforeEach(() => {
    mockGetContractStatus.mockReset();
  });

  it('returns contract status with 200', async () => {
    mockGetContractStatus.mockResolvedValue({ contract_id: 'C123', version: 1 });
    const res = await request(buildApp()).get('/contract/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contract_id: 'C123', version: 1 });
  });

  it('returns 500 with a configuration message when CONTRACT_ID is missing', async () => {
    mockGetContractStatus.mockRejectedValue(new Error('CONTRACT_ID environment variable is not set'));
    const res = await request(buildApp()).get('/contract/status');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Contract configuration is missing' });
  });

  it('returns 500 with a generic message for other failures', async () => {
    mockGetContractStatus.mockRejectedValue(new Error('upstream exploded'));
    const res = await request(buildApp()).get('/contract/status');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch contract status' });
  });
});

describe('POST /contract/upgrade', () => {
  const payload = { wasm_hash: 'abc123', version: 2 };
  const challengeId = 'challenge-1';

  beforeEach(() => {
    mockUpgradeContract.mockReset();
    mockRequirePermission.mockReset();
    mockVerifyStepUp.mockReset();
    mockRecordAudit.mockReset();

    mockRequirePermission.mockImplementation(() => (req, res, next) => next());
    mockVerifyStepUp.mockResolvedValue({ ok: true });
    mockUpgradeContract.mockResolvedValue({ contract_id: 'C123', version: 2 });
    mockRecordAudit.mockResolvedValue(undefined);
  });

  it('requires the configuration permission', async () => {
    mockRequirePermission.mockImplementation(() => (req, res) =>
      res.status(403).json({ error: 'Forbidden' })
    );
    const res = await request(buildApp())
      .post('/contract/upgrade')
      .send({ ...payload, challenge_id: challengeId });
    expect(res.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenCalledWith('contract:upgrade');
    expect(mockVerifyStepUp).not.toHaveBeenCalled();
    expect(mockUpgradeContract).not.toHaveBeenCalled();
  });

  it('upgrades the contract when the step-up challenge is valid', async () => {
    const res = await request(buildApp())
      .post('/contract/upgrade')
      .send({ ...payload, challenge_id: challengeId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contract_id: 'C123', version: 2 });
    expect(mockVerifyStepUp).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId,
        action: 'contract:upgrade',
        payloadHash: expect.any(String),
      })
    );
    expect(mockUpgradeContract).toHaveBeenCalledWith(payload);
  });

  it('rejects a missing step-up challenge with 400', async () => {
    const res = await request(buildApp()).post('/contract/upgrade').send(payload);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Step-up challenge is required' });
    expect(mockVerifyStepUp).not.toHaveBeenCalled();
    expect(mockUpgradeContract).not.toHaveBeenCalled();
  });

  it('rejects an expired step-up challenge with 401', async () => {
    mockVerifyStepUp.mockResolvedValue({ ok: false, reason: 'expired' });
    const res = await request(buildApp())
      .post('/contract/upgrade')
      .send({ ...payload, challenge_id: challengeId });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Step-up challenge expired' });
    expect(mockUpgradeContract).not.toHaveBeenCalled();
  });

  it('rejects a reused step-up challenge with 401', async () => {
    mockVerifyStepUp.mockResolvedValue({ ok: false, reason: 'reused' });
    const res = await request(buildApp())
      .post('/contract/upgrade')
      .send({ ...payload, challenge_id: challengeId });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Step-up challenge already used' });
    expect(mockUpgradeContract).not.toHaveBeenCalled();
  });

  it('rejects a challenge bound to a different payload with 409', async () => {
    mockVerifyStepUp.mockResolvedValue({ ok: false, reason: 'payload_mismatch' });
    const res = await request(buildApp())
      .post('/contract/upgrade')
      .send({ ...payload, challenge_id: challengeId });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Step-up challenge does not match payload' });
    expect(mockUpgradeContract).not.toHaveBeenCalled();
  });

  it('records audit evidence for successful upgrades', async () => {
    await request(buildApp())
      .post('/contract/upgrade')
      .send({ ...payload, challenge_id: challengeId });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contract:upgrade',
        challengeId,
        payloadHash: expect.any(String),
        outcome: 'success',
      })
    );
  });

  it('records audit evidence for rejected upgrades', async () => {
    mockVerifyStepUp.mockResolvedValue({ ok: false, reason: 'expired' });
    await request(buildApp())
      .post('/contract/upgrade')
      .send({ ...payload, challenge_id: challengeId });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contract:upgrade',
        challengeId,
        outcome: 'failure',
        reason: 'expired',
      })
    );
  });
});