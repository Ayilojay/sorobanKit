'use strict';

const {
  validateFederationResponse,
  validateNameResponse,
  validateIdResponse,
  FederationValidationError,
} = require('./federation');

const VALID_NAME_RESP = {
  stellar_address: 'alice*example.com',
  account_id: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
};

const VALID_ID_RESP = {
  stellar_address: 'alice*example.com',
  account_id: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
};

describe('validateNameResponse', () => {
  it('passes a valid name response', () => {
    expect(validateNameResponse(VALID_NAME_RESP)).toBe(true);
  });

  it('passes with valid memo fields', () => {
    expect(validateNameResponse({ ...VALID_NAME_RESP, memo_type: 'text', memo: 'hello' })).toBe(true);
    expect(validateNameResponse({ ...VALID_NAME_RESP, memo_type: 'id', memo: '12345' })).toBe(true);
  });

  it('throws on missing stellar_address', () => {
    const r = { ...VALID_NAME_RESP };
    delete r.stellar_address;
    expect(() => validateNameResponse(r)).toThrow(FederationValidationError);
  });

  it('throws on bad stellar_address format', () => {
    expect(() => validateNameResponse({ ...VALID_NAME_RESP, stellar_address: 'aliceexample.com' }))
      .toThrow(FederationValidationError);
  });

  it('throws on bad account_id', () => {
    expect(() => validateNameResponse({ ...VALID_NAME_RESP, account_id: 'BADKEY' }))
      .toThrow(FederationValidationError);
  });

  it('throws on memo_type without memo', () => {
    expect(() => validateNameResponse({ ...VALID_NAME_RESP, memo_type: 'text' }))
      .toThrow(FederationValidationError);
  });

  it('throws on invalid memo_type', () => {
    expect(() => validateNameResponse({ ...VALID_NAME_RESP, memo_type: 'binary', memo: 'x' }))
      .toThrow(FederationValidationError);
  });
});

describe('validateIdResponse', () => {
  it('passes a valid id response', () => {
    expect(validateIdResponse(VALID_ID_RESP)).toBe(true);
  });

  it('throws on missing account_id', () => {
    const r = { ...VALID_ID_RESP };
    delete r.account_id;
    expect(() => validateIdResponse(r)).toThrow(FederationValidationError);
  });
});

describe('validateFederationResponse', () => {
  it('dispatches to name validator', () => {
    expect(validateFederationResponse(VALID_NAME_RESP, 'name')).toBe(true);
  });

  it('dispatches to id validator', () => {
    expect(validateFederationResponse(VALID_ID_RESP, 'id')).toBe(true);
  });

  it('throws on unknown type', () => {
    expect(() => validateFederationResponse(VALID_NAME_RESP, 'forward')).toThrow(FederationValidationError);
  });
});
