/**
 * Redaction.
 *
 * We audit sites we do not own, we stream logs to a browser, and we ship
 * evidence to an LLM. Every one of those is a place a bearer token could leak.
 * Everything that crosses those boundaries goes through here first.
 */

/** Header names whose values we never store, log, or transmit. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-token',
  'x-access-token',
  'x-amz-security-token',
  'api-key',
  'auth-token',
]);

/** Query parameters that commonly carry credentials. */
const SENSITIVE_QUERY_PARAMS = [
  'token', 'access_token', 'refresh_token', 'id_token', 'auth', 'apikey', 'api_key',
  'key', 'secret', 'client_secret', 'password', 'passwd', 'pwd', 'session', 'sig',
  'signature', 'code',
];

const REDACTED = '[redacted]';

/** Strip sensitive headers, keeping the key so the reader knows it was present. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    out[key] = SENSITIVE_HEADERS.has(key) ? REDACTED : value;
  }
  return out;
}

/** Replace credential-bearing query parameter values in a URL. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    let touched = false;
    for (const param of SENSITIVE_QUERY_PARAMS) {
      for (const key of [...url.searchParams.keys()]) {
        if (key.toLowerCase() === param) {
          url.searchParams.set(key, REDACTED);
          touched = true;
        }
      }
    }
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      touched = true;
    }
    return touched ? url.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * Scrub token-shaped strings out of free text (console messages, stack traces,
 * error bodies) before it reaches a log stream or the LLM.
 */
const TOKEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'JWT' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: 'API key' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/g, label: 'GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS key id' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, label: 'Google API key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Slack token' },
  { re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, label: 'Authorization value' },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b(?=\s*(?:token|secret|key))/gi, label: 'UUID secret' },
];

export function redactText(input: string): string {
  let out = input;
  for (const { re, label } of TOKEN_PATTERNS) {
    out = out.replace(re, `[redacted:${label}]`);
  }
  return out;
}

/** Truncate a string with an explicit marker so readers know it was cut. */
export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}… [truncated ${input.length - maxLength} chars]`;
}

/**
 * Prepare a DOM snippet for storage: strip inline event handlers and any
 * attribute that looks like it holds a secret, then cap the length.
 */
export function sanitizeDomSnippet(html: string, maxLength = 600): string {
  const cleaned = html
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, ' [event-handler-removed]')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, ' [event-handler-removed]')
    .replace(/\s(data-[\w-]*(?:token|key|secret|auth)[\w-]*)\s*=\s*"[^"]*"/gi, ' $1="[redacted]"')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(redactText(cleaned), maxLength);
}
