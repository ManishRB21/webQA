/**
 * Security rules — PASSIVE ONLY.
 *
 * Everything here is derived from responses the browser received while loading
 * the page normally. Nothing probes, fuzzes, or attempts to bypass anything. We
 * are reading headers that the server volunteered, exactly as any visitor's
 * browser does.
 *
 * That restraint is a product decision, not a limitation. This tool audits
 * sites on the user's say-so, and an active scanner pointed at a site the user
 * does not own is an attack. Active scanning is gated behind explicit
 * authorization and is not implemented in this release.
 */

import { fingerprint, truncate } from '@webqa/shared';
import type { RawFinding } from '@webqa/shared';
import { occurrence, type PageRule, type SiteRule } from './types.js';

interface HeaderSpec {
  name: string;
  severity: RawFinding['severity'];
  title: string;
  why: string;
  fix: string;
  /** Returns a problem string when the value present is weak, or null when fine. */
  assess?: (value: string) => string | null;
}

const HEADER_SPECS: HeaderSpec[] = [
  {
    name: 'content-security-policy',
    severity: 'MEDIUM',
    title: 'No Content-Security-Policy header',
    why: 'CSP is the primary defence against cross-site scripting. It tells the browser which sources are allowed to execute script, so that even if an attacker manages to inject a `<script>` tag, the browser refuses to run it. Without a policy, any successful injection executes with full privileges.',
    fix: 'Deploy a Content-Security-Policy. Start in report-only mode (`Content-Security-Policy-Report-Only`) with a collection endpoint so you can see what would break before enforcing, then tighten toward `default-src \'self\'` with explicit allowances.',
    assess: (value) => {
      if (/unsafe-inline/i.test(value) && /script-src|default-src/i.test(value)) {
        return "the policy allows 'unsafe-inline' for scripts, which defeats most of its XSS protection";
      }
      if (/unsafe-eval/i.test(value)) return "the policy allows 'unsafe-eval'";
      if (/(default-src|script-src)[^;]*\*(\s|;|$)/i.test(value)) {
        return 'the policy uses a wildcard source, which permits script from any origin';
      }
      return null;
    },
  },
  {
    name: 'strict-transport-security',
    severity: 'MEDIUM',
    title: 'No Strict-Transport-Security header',
    why: 'HSTS instructs the browser to use HTTPS for this host for a stated period, without waiting for a redirect. It closes the window in which a first plain-http request can be intercepted and downgraded — the classic coffee-shop attack.',
    fix: 'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Roll out with a short max-age first and confirm every subdomain serves HTTPS correctly before extending it, because the directive is not easily reversible in browsers that have cached it.',
    assess: (value) => {
      const maxAge = /max-age=(\d+)/i.exec(value);
      if (!maxAge) return 'the header has no max-age directive, so it has no effect';
      if (Number(maxAge[1]) < 15_552_000) {
        return `max-age is ${maxAge[1]} seconds, below the 6-month minimum that preload lists require`;
      }
      return null;
    },
  },
  {
    name: 'x-content-type-options',
    severity: 'LOW',
    title: 'No X-Content-Type-Options header',
    why: 'Without `nosniff`, browsers may ignore the declared Content-Type and guess based on content. A user-uploaded file served as text/plain but containing HTML can then be interpreted as HTML and execute script.',
    fix: 'Add `X-Content-Type-Options: nosniff`. It has essentially no compatibility risk.',
    assess: (value) => (/nosniff/i.test(value) ? null : `value is "${value}" rather than "nosniff"`),
  },
  {
    name: 'referrer-policy',
    severity: 'LOW',
    title: 'No Referrer-Policy header',
    why: 'Without an explicit policy, browsers send the full URL of the current page — path and query string included — to third-party resources. Where URLs contain identifiers, reset tokens, or search terms, that is a quiet data leak to every analytics and ad domain on the page.',
    fix: 'Add `Referrer-Policy: strict-origin-when-cross-origin`. This keeps full referrer information for same-origin navigation while sending only the origin to third parties.',
    assess: (value) =>
      /unsafe-url|no-referrer-when-downgrade/i.test(value)
        ? `the policy "${value}" still leaks full URLs to third parties`
        : null,
  },
  {
    name: 'permissions-policy',
    severity: 'INFO',
    title: 'No Permissions-Policy header',
    why: 'Permissions-Policy lets a site declare which powerful browser features (camera, microphone, geolocation, payment) may be used, including by embedded third-party frames. Without it, any embedded content can request those permissions in the site\'s name.',
    fix: 'Add a Permissions-Policy disabling features the site does not use, e.g. `Permissions-Policy: camera=(), microphone=(), geolocation=()`.',
  },
  {
    name: 'x-frame-options',
    severity: 'LOW',
    title: 'No clickjacking protection',
    why: 'Without `X-Frame-Options` or a CSP `frame-ancestors` directive, the page can be embedded in an invisible iframe on an attacker\'s site and overlaid with decoy controls, so a user believes they are clicking one thing while actually clicking another on your site.',
    fix: 'Add `X-Frame-Options: SAMEORIGIN`, or preferably the modern equivalent `Content-Security-Policy: frame-ancestors \'self\'`.',
  },
];

export const securityHeadersRule: PageRule = {
  id: 'security.headers',
  description: 'Missing or weak HTTP security headers',
  run({ page }) {
    const security = page.security;
    if (!security) return [];

    // Only assess the main document response — sub-resource headers are the
    // responsibility of whoever serves them.
    const documentRequest = page.requests.find((request) => request.resourceKind === 'document');
    const headers = { ...security.headers, ...(documentRequest?.responseHeaders ?? {}) };

    const findings: RawFinding[] = [];

    for (const spec of HEADER_SPECS) {
      const value = headers[spec.name];

      // frame-ancestors in CSP supersedes X-Frame-Options.
      if (spec.name === 'x-frame-options' && /frame-ancestors/i.test(headers['content-security-policy'] ?? '')) {
        continue;
      }
      // HSTS is meaningless over plain http.
      if (spec.name === 'strict-transport-security' && !security.isHttps) continue;

      if (!value) {
        findings.push({
          ruleId: `security.missing-${spec.name}`,
          fingerprint: fingerprint('security.missing-header', spec.name),
          title: spec.title,
          category: 'SECURITY',
          severity: spec.severity,
          confidence: 'CONFIRMED',
          description: `The \`${spec.name}\` response header is not set.`,
          measuredFacts: [
            { label: 'Header', value: spec.name, source: 'HTTP response headers' },
            { label: 'Present', value: 'no', source: 'HTTP response headers' },
          ],
          inference: spec.why,
          technicalDetails: `Response headers observed on the document request:\n${Object.keys(headers).sort().map((key) => `  ${key}`).join('\n')}`,
          impact:
            'This is a missing defence-in-depth control rather than an exploitable vulnerability on its own. It increases the damage another flaw could do.',
          recommendation: spec.fix,
          estimatedEffort: 'SMALL',
          standardsRef: 'OWASP Secure Headers Project',
          occurrences: [occurrence({ pageUrl: page.url, detail: `${spec.name} not set` })],
        });
        continue;
      }

      const problem = spec.assess?.(value);
      if (problem) {
        findings.push({
          ruleId: `security.weak-${spec.name}`,
          fingerprint: fingerprint('security.weak-header', spec.name),
          title: `Weak ${spec.name} configuration`,
          category: 'SECURITY',
          severity: spec.severity,
          confidence: 'CONFIRMED',
          description: `The \`${spec.name}\` header is set, but ${problem}.`,
          measuredFacts: [
            { label: 'Header', value: spec.name, source: 'HTTP response headers' },
            { label: 'Value', value: truncate(value, 300), source: 'HTTP response headers' },
            { label: 'Issue', value: problem, source: 'Policy analysis' },
          ],
          inference: `${spec.why} The header is present here, but ${problem} — so the protection it is supposed to provide is substantially reduced.`,
          technicalDetails: `${spec.name}: ${truncate(value, 500)}`,
          impact: 'The control is present but not providing its intended protection.',
          recommendation: spec.fix,
          estimatedEffort: 'MEDIUM',
          standardsRef: 'OWASP Secure Headers Project',
          occurrences: [occurrence({ pageUrl: page.url, detail: truncate(value, 200) })],
        });
      }
    }

    return findings;
  },
};

export const httpsRule: PageRule = {
  id: 'security.https',
  description: 'Page not served over HTTPS',
  run({ page }) {
    const security = page.security;
    if (!security || security.isHttps) return [];

    return [{
      ruleId: 'security.no-https',
      fingerprint: fingerprint('security.no-https'),
      title: 'Page is served over plain HTTP',
      category: 'SECURITY',
      severity: 'CRITICAL',
      confidence: 'CONFIRMED',
      description: 'This page was served over http:// rather than https://.',
      measuredFacts: [
        { label: 'Protocol', value: 'http', source: 'Final page URL' },
        { label: 'URL', value: truncate(page.url, 160), source: 'Navigation observation' },
      ],
      inference:
        'Traffic over plain HTTP is transmitted in cleartext. Anyone on the network path — another device on the same wifi, an ISP, a compromised router — can read every page the user views and every value they submit, and can modify the response before it arrives. There is no scenario in which this is acceptable for a site handling any user input.',
      technicalDetails: `Page URL: ${page.url}\nNo TLS in use.`,
      impact:
        'Credentials, personal data, and session cookies are exposed to interception. Content can be modified in transit to inject arbitrary script. Browsers mark the site "Not secure", and search engines rank it lower.',
      recommendation:
        'Obtain a certificate (Let\'s Encrypt issues them free and automatically), redirect all HTTP traffic to HTTPS with a 301, and then add HSTS so browsers stop attempting HTTP at all.',
      estimatedEffort: 'MEDIUM',
      standardsRef: 'OWASP A02:2021 — Cryptographic Failures',
      occurrences: [occurrence({ pageUrl: page.url, detail: 'Served over http://' })],
    }];
  },
};

export const mixedContentRule: PageRule = {
  id: 'security.mixed-content',
  description: 'HTTP sub-resources loaded from an HTTPS page',
  run({ page }) {
    if (!page.security?.isHttps) return [];

    const insecure = page.requests.filter((request) => request.url.startsWith('http://'));
    if (insecure.length === 0) return [];

    const active = insecure.filter(
      (request) => request.resourceKind === 'script' || request.resourceKind === 'stylesheet',
    );

    return [{
      ruleId: 'security.mixed-content',
      fingerprint: fingerprint('security.mixed-content', active.length > 0 ? 'active' : 'passive'),
      title: active.length > 0 ? 'Active mixed content on an HTTPS page' : 'Mixed content on an HTTPS page',
      category: 'SECURITY',
      severity: active.length > 0 ? 'HIGH' : 'MEDIUM',
      confidence: 'CONFIRMED',
      description: `${insecure.length} resource(s) are requested over plain HTTP from a page served over HTTPS.`,
      measuredFacts: [
        { label: 'Insecure requests', value: insecure.length, source: 'Chromium network stack' },
        { label: 'Of which scripts or stylesheets', value: active.length, source: 'Chromium network stack' },
        ...insecure.slice(0, 4).map((request) => ({
          label: request.resourceKind,
          value: truncate(request.url, 120),
          source: 'Chromium network stack',
        })),
      ],
      inference:
        active.length > 0
          ? 'These are "active" mixed content — script and stylesheet resources fetched over an unencrypted channel. An attacker on the network path can replace them with arbitrary code that then runs with full privileges on the HTTPS page, which defeats the encryption entirely. Modern browsers block active mixed content outright, so the resources are also simply not loading.'
          : 'These are "passive" mixed content — images and media over HTTP. They cannot execute code, but they can be replaced in transit, they leak which resources the user is viewing, and they cause the browser to downgrade its security indicator.',
      technicalDetails: insecure
        .slice(0, 12)
        .map((request) => `${request.resourceKind.padEnd(11)} ${truncate(request.url, 90)}`)
        .join('\n'),
      impact:
        active.length > 0
          ? 'The page\'s HTTPS guarantee is void, and the blocked resources mean functionality is likely broken as well.'
          : 'Degraded security indicator and a privacy leak; content can be tampered with in transit.',
      recommendation:
        'Change these references to https:// (most hosts now support it). Where a URL is built dynamically, use protocol-relative or absolute https URLs. Add `Content-Security-Policy: upgrade-insecure-requests` as a safety net.',
      estimatedEffort: 'SMALL',
      standardsRef: 'OWASP A02:2021 — Cryptographic Failures',
      occurrences: insecure.slice(0, 20).map((request) =>
        occurrence({ pageUrl: page.url, detail: `${request.resourceKind}: ${truncate(request.url, 140)}` }),
      ),
    }];
  },
};

export const cookieSecurityRule: PageRule = {
  id: 'security.cookies',
  description: 'Cookies without security attributes',
  run({ page }) {
    const cookies = page.security?.cookies ?? [];
    if (cookies.length === 0) return [];

    const insecure = cookies.filter((cookie) => !cookie.secure && page.security?.isHttps);
    const noHttpOnly = cookies.filter((cookie) => !cookie.httpOnly);
    const noSameSite = cookies.filter((cookie) => !cookie.sameSite || cookie.sameSite === 'None');

    if (insecure.length === 0 && noHttpOnly.length === 0 && noSameSite.length === 0) return [];

    return [{
      ruleId: 'security.cookie-attributes',
      fingerprint: fingerprint('security.cookie-attributes'),
      title: 'Cookies are missing security attributes',
      category: 'SECURITY',
      severity: insecure.length > 0 ? 'MEDIUM' : 'LOW',
      // We can see the flags but not what the cookie is for. A tracking cookie
      // without HttpOnly is unremarkable; a session cookie without it is not.
      confidence: 'LIKELY',
      description: `${cookies.length} cookie(s) observed; ${insecure.length} without Secure, ${noHttpOnly.length} without HttpOnly, ${noSameSite.length} without a restrictive SameSite.`,
      measuredFacts: [
        { label: 'Cookies observed', value: cookies.length, source: 'CDP Network.getAllCookies' },
        { label: 'Missing Secure', value: insecure.length, source: 'Cookie attributes' },
        { label: 'Missing HttpOnly', value: noHttpOnly.length, source: 'Cookie attributes' },
        { label: 'Missing/None SameSite', value: noSameSite.length, source: 'Cookie attributes' },
      ],
      inference:
        '`Secure` stops the cookie being sent over plain HTTP. `HttpOnly` stops JavaScript reading it, which is what limits the damage of an XSS flaw to actions rather than session theft. `SameSite=Lax` or `Strict` stops it being attached to cross-site requests, which is the main structural defence against CSRF. We can observe which attributes are set but not what each cookie is used for — a missing HttpOnly on an analytics cookie is unremarkable, on a session cookie it is serious.',
      technicalDetails: cookies
        .slice(0, 15)
        .map((cookie) => `${cookie.name.padEnd(28)} secure=${String(cookie.secure).padEnd(5)} httpOnly=${String(cookie.httpOnly).padEnd(5)} sameSite=${cookie.sameSite ?? 'none'}`)
        .join('\n'),
      impact:
        'Where any of these cookies carries a session, the missing attributes translate directly into session theft via XSS, session leakage over HTTP, or CSRF.',
      recommendation:
        'Set `Secure; HttpOnly; SameSite=Lax` on every session and authentication cookie. Where a cookie must be readable by client-side script, confirm that is genuinely required — it usually is not.',
      estimatedEffort: 'SMALL',
      standardsRef: 'OWASP A05:2021 — Security Misconfiguration',
      occurrences: [
        occurrence({
          pageUrl: page.url,
          detail: `${cookies.length} cookies inspected`,
          inlineEvidence: {
            kind: 'HEADERS',
            caption: 'Cookie attributes (names and flags only — values are never recorded)',
            data: cookies.map((cookie) => ({
              name: cookie.name,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite,
            })),
          },
        }),
      ],
    }];
  },
};

export const thirdPartyScriptRule: SiteRule = {
  id: 'security.third-party-scripts',
  description: 'Third-party script origins with execution privileges',
  run({ pages }) {
    const origins = new Map<string, number>();
    for (const page of pages) {
      for (const request of page.requests) {
        if (request.resourceKind !== 'script' || !request.isThirdParty) continue;
        origins.set(request.origin, (origins.get(request.origin) ?? 0) + 1);
      }
    }

    if (origins.size < 5) return [];

    const sorted = [...origins.entries()].sort((a, b) => b[1] - a[1]);

    return [{
      ruleId: 'security.third-party-scripts',
      fingerprint: fingerprint('security.third-party-scripts'),
      title: `${origins.size} third-party origins execute JavaScript on this site`,
      category: 'SECURITY',
      severity: origins.size > 12 ? 'MEDIUM' : 'LOW',
      // Counting origins is exact; whether that count is a problem depends on
      // which vendors they are and what the site does.
      confidence: 'LIKELY',
      description: `Scripts are loaded from ${origins.size} distinct third-party origins.`,
      measuredFacts: [
        { label: 'Third-party script origins', value: origins.size, source: 'Chromium network stack' },
        ...sorted.slice(0, 8).map(([origin, count]) => ({
          label: origin,
          value: `${count} request${count === 1 ? '' : 's'}`,
          source: 'Chromium network stack',
        })),
      ],
      inference:
        'A third-party script runs with the same privileges as first-party code: it can read the DOM, read non-HttpOnly cookies, observe form input, and issue authenticated requests. Each origin is therefore an entry in the site\'s trust boundary, and the site inherits the security posture of every one of them. This is the mechanism behind Magecart-style attacks, where a compromised analytics or widget vendor is used to skim payment forms across thousands of sites at once.',
      technicalDetails: sorted.map(([origin, count]) => `${count.toString().padStart(4)} requests  ${origin}`).join('\n'),
      impact:
        'A compromise at any one of these vendors becomes a compromise of this site. On pages handling payment or credentials, that risk is material rather than theoretical.',
      recommendation:
        'Review the list and remove anything no longer needed — third-party tags accumulate and are rarely audited. For the ones that remain, use Subresource Integrity where the vendor serves versioned files, and restrict `script-src` in your CSP to this reviewed list so a newly-injected origin cannot execute.',
      estimatedEffort: 'MEDIUM',
      standardsRef: 'OWASP A08:2021 — Software and Data Integrity Failures',
      occurrences: [occurrence({ pageUrl: pages[0]?.url ?? '', detail: `${origins.size} third-party script origins` })],
    }];
  },
};

export const securityPageRules: PageRule[] = [
  httpsRule,
  securityHeadersRule,
  mixedContentRule,
  cookieSecurityRule,
];

export const securitySiteRules: SiteRule[] = [thirdPartyScriptRule];
