/**
 * SSRF protection.
 *
 * This service fetches arbitrary user-supplied URLs with a real browser. That
 * makes it a confused deputy: without guards, a user could point it at
 * `http://169.254.169.254/latest/meta-data/` and read our cloud credentials
 * out of the screenshot.
 *
 * Defence is two-layered because either layer alone is insufficient:
 *
 *   1. Syntactic checks on the URL (scheme, obvious literals, ports).
 *   2. DNS resolution followed by an IP-range check. This catches
 *      `evil.example.com A 127.0.0.1` — a hostname that looks public but
 *      resolves private.
 *
 * Note the TOCTOU gap between our resolution and the browser's: a hostile DNS
 * server can return a public IP to us and a private one to Chromium (DNS
 * rebinding). Closing that fully requires pinning the resolved IP at the
 * network layer, which we do not do in the MVP — so the browser also runs with
 * network egress restricted at the container level (see docker-compose).
 */

export interface SsrfCheckResult {
  allowed: boolean;
  reason: string | null;
  /** IPs the hostname resolved to, when resolution was performed. */
  resolvedAddresses: string[];
}

export interface SsrfOptions {
  enabled: boolean;
  /** Hostnames exempt from the check. Used for auditing internal staging. */
  allowlist: string[];
  /** Ports other than 80/443 that are acceptable. */
  allowedPorts: number[];
}

export const DEFAULT_SSRF_OPTIONS: SsrfOptions = {
  enabled: true,
  allowlist: [],
  allowedPorts: [80, 443, 8080, 8443, 3000],
};

/** Hostnames that must never be resolved, regardless of DNS. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Suffixes that indicate an internal-only name. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

interface CidrRange {
  base: number;
  mask: number;
  label: string;
}

function cidr(notation: string, label: string): CidrRange {
  const [addr, bitsRaw] = notation.split('/');
  const base = ipv4ToInt(addr ?? '') ?? 0;
  const bits = Number(bitsRaw ?? 32);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, label };
}

/** RFC1918 + loopback + link-local + carrier-grade NAT + reserved. */
const BLOCKED_V4_RANGES: CidrRange[] = [
  cidr('0.0.0.0/8', 'this network'),
  cidr('10.0.0.0/8', 'RFC1918 private'),
  cidr('100.64.0.0/10', 'carrier-grade NAT'),
  cidr('127.0.0.0/8', 'loopback'),
  cidr('169.254.0.0/16', 'link-local / cloud metadata'),
  cidr('172.16.0.0/12', 'RFC1918 private'),
  cidr('192.0.0.0/24', 'IETF protocol assignments'),
  cidr('192.0.2.0/24', 'TEST-NET-1'),
  cidr('192.88.99.0/24', '6to4 relay anycast'),
  cidr('192.168.0.0/16', 'RFC1918 private'),
  cidr('198.18.0.0/15', 'benchmarking'),
  cidr('198.51.100.0/24', 'TEST-NET-2'),
  cidr('203.0.113.0/24', 'TEST-NET-3'),
  cidr('224.0.0.0/4', 'multicast'),
  cidr('240.0.0.0/4', 'reserved'),
];

/** Classify an IPv4 literal. Returns a reason string when blocked. */
export function checkIpv4(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return null;
  for (const range of BLOCKED_V4_RANGES) {
    if (((value & range.mask) >>> 0) === range.base) return `${ip} is ${range.label}`;
  }
  return null;
}

/** Classify an IPv6 literal. Conservative — blocks anything not global unicast. */
export function checkIpv6(ip: string): string | null {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (normalized === '::1') return `${ip} is loopback`;
  if (normalized === '::') return `${ip} is unspecified`;
  // IPv4-mapped (::ffff:127.0.0.1) — unwrap and re-check.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) {
    const inner = checkIpv4(mapped[1]);
    return inner ? `${ip} maps to ${inner}` : null;
  }
  if (/^f[cd]/.test(normalized)) return `${ip} is unique-local (fc00::/7)`;
  if (/^fe[89ab]/.test(normalized)) return `${ip} is link-local (fe80::/10)`;
  if (/^ff/.test(normalized)) return `${ip} is multicast`;
  return null;
}

/** Check a resolved address of either family. */
export function checkAddress(address: string): string | null {
  return address.includes(':') ? checkIpv6(address) : checkIpv4(address);
}

/**
 * Syntactic validation — everything checkable without touching DNS.
 * Callers must still run `assertResolvedAddresses` after resolution.
 */
export function checkUrlSyntax(rawUrl: string, options: SsrfOptions): SsrfCheckResult {
  const deny = (reason: string): SsrfCheckResult => ({ allowed: false, reason, resolvedAddresses: [] });

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny('URL could not be parsed');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return deny(`Unsupported scheme "${url.protocol}" — only http and https are allowed`);
  }

  if (url.username || url.password) {
    return deny('URLs containing embedded credentials are not accepted');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) return deny('URL has no host');

  if (!options.enabled) {
    return { allowed: true, reason: null, resolvedAddresses: [] };
  }

  if (options.allowlist.some((entry) => entry.toLowerCase() === hostname)) {
    return { allowed: true, reason: null, resolvedAddresses: [] };
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return deny(`Host "${hostname}" refers to the local machine`);
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) return deny(`Host "${hostname}" is an internal-only name`);
  }

  // Reject literal private IPs before we ever hit DNS.
  const literal = checkAddress(hostname);
  if (literal) return deny(`Blocked: ${literal}`);

  // Decimal / octal / hex encodings of IPv4 that bypass naive string checks.
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname) || /^0\d+$/.test(hostname)) {
    return deny(`Host "${hostname}" is an encoded IP literal`);
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!options.allowedPorts.includes(port)) {
    return deny(`Port ${port} is not in the allowed list (${options.allowedPorts.join(', ')})`);
  }

  return { allowed: true, reason: null, resolvedAddresses: [] };
}

/**
 * Post-resolution check. Every address the hostname resolved to must be
 * publicly routable — if any is private, we refuse, because we cannot control
 * which one the browser picks.
 */
export function assertResolvedAddresses(
  hostname: string,
  addresses: string[],
  options: SsrfOptions,
): SsrfCheckResult {
  if (!options.enabled) return { allowed: true, reason: null, resolvedAddresses: addresses };
  if (options.allowlist.some((entry) => entry.toLowerCase() === hostname.toLowerCase())) {
    return { allowed: true, reason: null, resolvedAddresses: addresses };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `Host "${hostname}" did not resolve to any address`, resolvedAddresses: [] };
  }
  for (const address of addresses) {
    const problem = checkAddress(address);
    if (problem) {
      return {
        allowed: false,
        reason: `Host "${hostname}" resolves to a non-public address — ${problem}`,
        resolvedAddresses: addresses,
      };
    }
  }
  return { allowed: true, reason: null, resolvedAddresses: addresses };
}
