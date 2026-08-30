/**
 * @webqa/shared — the domain model.
 *
 * Everything here is dependency-light on purpose: the API, the worker, and the
 * React client all import it, so it must not pull in Node-only or DOM-only
 * code beyond `node:crypto`.
 */

export * from './types/common.js';
export * from './types/observation.js';
export * from './types/finding.js';
export * from './types/audit.js';
export * from './types/report.js';
export * from './types/api.js';

export * from './scoring/priority.js';
export * from './scoring/health.js';

export * from './url/normalize.js';
export * from './url/ssrf.js';

export * from './util/fingerprint.js';
export * from './util/redact.js';
