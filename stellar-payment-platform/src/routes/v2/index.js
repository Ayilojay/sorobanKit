'use strict';

const express = require('express');
const etagMiddleware = require('../../middleware/etag');

module.exports = (redisClient) => {
  const router = express.Router();

  router.use((req, res, next) => {
    req.apiVersion = 'v2';
    next();
  });

  // Public metadata responses get canonical ETag validators and support
  // conditional requests (If-None-Match -> 304).
  router.get('/', etagMiddleware(), (req, res) => {
    res.status(200).json({ apiVersion: 'v2', status: 'ok' });
  });

  // Authorization-dependent responses must never be shared-cached. Mark them
  // private/no-store before delegating to the v1 handlers.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Authorization');
    next();
  });

  // Endpoints not yet implemented in v2 fall through to the v1 router, so
  // /api/v2/... keeps working while handlers are ported one by one.
  router.use('/', require('../v1')(redisClient));

  return router;
};