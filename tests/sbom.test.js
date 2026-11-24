'use strict';

/**
 * Tests for SBOM (Software Bill of Materials) generation.
 *
 * These tests generate or load a CycloneDX SBOM for the Node artifact and
 * assert that it is well-formed and tied to the source revision and artifact
 * digest. They act as the CI check required by issue #463.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SBOM_DIR = path.join(ROOT, 'sbom');
const SBOM_FILE = path.join(SBOM_DIR, 'node.cyclonedx.json');
const GENERATOR = path.join(ROOT, 'scripts', 'generate-sbom.js');
const PROVENANCE_FILE = path.join(SBOM_DIR, 'node.provenance.json');
const PROVENANCE_VERIFIER = path.join(ROOT, 'scripts', 'verify-provenance.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

function readJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${p}: ${err.message}`);
  }
}

/**
 * Generate the SBOM if it is missing, otherwise load the existing one.
 * Returns the parsed SBOM document.
 */
function loadOrGenerateSbom() {
  if (!fileExists(SBOM_FILE)) {
    assert.ok(
      fileExists(GENERATOR),
      `SBOM is missing at ${SBOM_FILE} and no generator found at ${GENERATOR}`
    );
    fs.mkdirSync(SBOM_DIR, { recursive: true });
    execFileSync(process.execPath, [GENERATOR, '--output', SBOM_FILE], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
  assert.ok(fileExists(SBOM_FILE), `SBOM not found at ${SBOM_FILE}`);
  return readJson(SBOM_FILE);
}

/**
 * Compute the SHA-256 digest of a file as a lowercase hex string.
 */
function sha256File(p) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(p));
  return hash.digest('hex');
}

/**
 * Generate the provenance attestation if it is missing, otherwise load the
 * existing one. Returns the parsed in-toto/SLSA provenance document.
 */
function loadOrGenerateProvenance() {
  if (!fileExists(PROVENANCE_FILE)) {
    assert.ok(
      fileExists(GENERATOR),
      `Provenance is missing at ${PROVENANCE_FILE} and no generator found at ${GENERATOR}`
    );
    fs.mkdirSync(SBOM_DIR, { recursive: true });
    execFileSync(process.execPath, [GENERATOR, '--output', SBOM_FILE], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
  assert.ok(fileExists(PROVENANCE_FILE), `Provenance not found at ${PROVENANCE_FILE}`);
  return readJson(PROVENANCE_FILE);
}

/**
 * Run the provenance verifier against a given artifact path.
 * Returns { status, stdout, stderr } without throwing on non-zero exit.
 */
function runProvenanceVerifier(artifactPath) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [PROVENANCE_VERIFIER, '--provenance', PROVENANCE_FILE, '--artifact', artifactPath],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

/**
 * Minimal structural validation of a CycloneDX 1.x JSON document.
 * Returns an array of error strings (empty when valid).
 */
function validateCycloneDx(doc) {
  const errors = [];

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['SBOM root must be a JSON object'];
  }

  if (typeof doc.bomFormat !== 'string' || doc.bomFormat !== 'CycloneDX') {
    errors.push('bomFormat must be "CycloneDX"');
  }

  if (typeof doc.specVersion !== 'string' || !/^1\.\d+$/.test(doc.specVersion)) {
    errors.push('specVersion must be a CycloneDX 1.x version string');
  }

  if (typeof doc.version !== 'number' || !Number.isInteger(doc.version) || doc.version < 1) {
    errors.push('version must be a positive integer');
  }

  if (!Array.isArray(doc.components)) {
    errors.push('components must be an array');
  } else {
    doc.components.forEach((component, idx) => {
      if (component === null || typeof component !== 'object') {
        errors.push(`components[${idx}] must be an object`);
        return;
      }
      if (typeof component.type !== 'string' || component.type.length === 0) {
        errors.push(`components[${idx}].type must be a non-empty string`);
      }
      if (typeof component.name !== 'string' || component.name.length === 0) {
        errors.push(`components[${idx}].name must be a non-empty string`);
      }
    });
  }

  if (doc.metadata === null || typeof doc.metadata !== 'object') {
    errors.push('metadata must be an object');
  } else {
    if (typeof doc.metadata.timestamp !== 'string') {
      errors.push('metadata.timestamp must be a string');
    } else if (Number.isNaN(Date.parse(doc.metadata.timestamp))) {
      errors.push('metadata.timestamp must be a valid ISO-8601 date');
    }

    const comp = doc.metadata.component;
    if (comp === null || typeof comp !== 'object') {
      errors.push('metadata.component must be an object');
    } else {
      if (typeof comp.type !== 'string' || comp.type.length === 0) {
        errors.push('metadata.component.type must be a non-empty string');
      }
      if (typeof comp.name !== 'string' || comp.name.length === 0) {
        errors.push('metadata.component.name must be a non-empty string');
      }
    }
  }

  return errors;
}

/**
 * Extract a custom property value from a CycloneDX element's `properties`
 * array. Returns undefined when not present.
 */
function getProperty(element, name) {
  if (!element || !Array.isArray(element.properties)) {
    return undefined;
  }
  const match = element.properties.find(
    (prop) => prop && prop.name === name
  );
  return match ? match.value : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CycloneDX SBOM for the Node artifact', () => {
  let sbom;

  before(() => {
    sbom = loadOrGenerateSbom();
  });

  it('is valid CycloneDX JSON', () => {
    const errors = validateCycloneDx(sbom);
    assert.deepStrictEqual(errors, [], `Invalid CycloneDX SBOM:\n${errors.join('\n')}`);
  });

  it('has a metadata.timestamp', () => {
    assert.ok(sbom.metadata, 'metadata is missing');
    assert.strictEqual(
      typeof sbom.metadata.timestamp,
      'string',
      'metadata.timestamp must be a string'
    );
    assert.ok(
      !Number.isNaN(Date.parse(sbom.metadata.timestamp)),
      `metadata.timestamp is not a valid date: ${sbom.metadata.timestamp}`
    );
  });

  it('has a metadata.component describing the Node artifact', () => {
    assert.ok(sbom.metadata, 'metadata is missing');
    const comp = sbom.metadata.component;
    assert.ok(comp && typeof comp === 'object', 'metadata.component is missing');
    assert.strictEqual(typeof comp.type, 'string');
    assert.ok(comp.type.length > 0, 'metadata.component.type must be non-empty');
    assert.strictEqual(typeof comp.name, 'string');
    assert.ok(comp.name.length > 0, 'metadata.component.name must be non-empty');
  });

  it('records the git commit SHA as a custom property', () => {
    const sha = getProperty(sbom.metadata.component, 'git:commit');
    assert.ok(
      typeof sha === 'string' && sha.length > 0,
      'metadata.component must have a "git:commit" property'
    );
    assert.match(
      sha,
      /^[0-9a-f]{7,40}$/i,
      `git:commit property is not a valid commit SHA: ${sha}`
    );
  });

  it('records the artifact digest as a custom property', () => {
    const digest = getProperty(sbom.metadata.component, 'artifact:digest');
    assert.ok(
      typeof digest === 'string' && digest.length > 0,
      'metadata.component must have an "artifact:digest" property'
    );
    assert.match(
      digest,
      /^sha256:[0-9a-f]{64}$/i,
      `artifact:digest property is not a valid sha256 digest: ${digest}`
    );
  });

  it('ties the artifact digest to the packaged Node artifact', () => {
    const digest = getProperty(sbom.metadata.component, 'artifact:digest');
    assert.ok(digest, 'artifact:digest property is missing');

    const artifactPath = path.join(ROOT, 'package.json');
    assert.ok(fileExists(artifactPath), `Node artifact not found at ${artifactPath}`);

    const expected = `sha256:${sha256File(artifactPath)}`;
    assert.strictEqual(
      digest.toLowerCase(),
      expected.toLowerCase(),
      `artifact:digest does not match the digest of ${artifactPath}`
    );
  });

  it('fails when the SBOM is malformed', () => {
    const broken = JSON.parse(JSON.stringify(sbom));
    delete broken.metadata;
    const errors = validateCycloneDx(broken);
    assert.ok(errors.length > 0, 'validator must reject an SBOM without metadata');
  });

  it('fails when required custom properties are missing', () => {
    const broken = JSON.parse(JSON.stringify(sbom));
    broken.metadata.component.properties = [];
    assert.strictEqual(
      getProperty(broken.metadata.component, 'git:commit'),
      undefined,
      'missing git:commit property must be detected'
    );
    assert.strictEqual(
      getProperty(broken.metadata.component, 'artifact:digest'),
      undefined,
      'missing artifact:digest property must be detected'
    );
  });
});

describe('Build provenance attestation for the Node artifact', () => {
  let provenance;

  before(() => {
    provenance = loadOrGenerateProvenance();
  });

  it('is a well-formed in-toto statement', () => {
    assert.ok(provenance && typeof provenance === 'object', 'provenance must be an object');
    assert.strictEqual(
      provenance._type,
      'https://in-toto.io/Statement/v1',
      'provenance must be an in-toto Statement v1'
    );
    assert.strictEqual(
      provenance.predicateType,
      'https://slsa.dev/provenance/v1',
      'provenance must use the SLSA provenance v1 predicate'
    );
    assert.ok(Array.isArray(provenance.subject), 'subject must be an array');
    assert.ok(provenance.subject.length > 0, 'subject must not be empty');
    assert.ok(
      provenance.predicate && typeof provenance.predicate === 'object',
      'predicate must be an object'
    );
  });

  it('has a subject digest matching the packaged Node artifact', () => {
    const artifactPath = path.join(ROOT, 'package.json');
    assert.ok(fileExists(artifactPath), `Node artifact not found at ${artifactPath}`);
    const expected = sha256File(artifactPath);

    const subject = provenance.subject.find(
      (s) => s && typeof s.name === 'string' && s.name.endsWith('package.json')
    );
    assert.ok(subject, 'provenance subject must reference package.json');
    assert.ok(subject.digest && typeof subject.digest === 'object', 'subject.digest is missing');
    assert.strictEqual(
      String(subject.digest.sha256).toLowerCase(),
      expected.toLowerCase(),
      'subject digest does not match the artifact bytes'
    );
  });

  it('records the source commit and workflow identity', () => {
    const predicate = provenance.predicate;
    const buildDef = predicate.buildDefinition || {};
    const external = buildDef.externalParameters || {};
    const source = external.source || {};
    const workflow = external.workflow || {};

    assert.match(
      String(source.commit || ''),
      /^[0-9a-f]{7,40}$/i,
      `source commit is not a valid SHA: ${source.commit}`
    );
    assert.ok(
      typeof workflow.repository === 'string' && workflow.repository.length > 0,
      'workflow.repository must be a non-empty string'
    );
    assert.ok(
      typeof workflow.path === 'string' && workflow.path.length > 0,
      'workflow.path must be a non-empty string'
    );
    assert.ok(
      typeof workflow.ref === 'string' && workflow.ref.length > 0,
      'workflow.ref must be a non-empty string'
    );
  });

  it('verifies successfully against the unmodified artifact', () => {
    const artifactPath = path.join(ROOT, 'package.json');
    const result = runProvenanceVerifier(artifactPath);
    assert.strictEqual(
      result.status,
      0,
      `verifier should accept the unmodified artifact:\n${result.stderr}`
    );
  });

  it('fails verification when the artifact bytes are altered', () => {
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'provenance-'));
    const tamperedPath = path.join(tmpDir, 'package.json');
    try {
      const original = fs.readFileSync(path.join(ROOT, 'package.json'));
      const tampered = Buffer.concat([original, Buffer.from('\n')]);
      fs.writeFileSync(tamperedPath, tampered);

      const result = runProvenanceVerifier(tamperedPath);
      assert.notStrictEqual(
        result.status,
        0,
        'verifier must fail when the artifact digest does not match'
      );
      assert.match(
        `${result.stdout}${result.stderr}`,
        /digest|mismatch/i,
        'verifier failure should mention a digest mismatch'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});