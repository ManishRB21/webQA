/**
 * Performance rules.
 *
 * The standard the whole product is judged by lives here. Not:
 *
 *   "Your site is slow."
 *
 * but:
 *
 *   "The hero image at /img/hero.jpg is 1.8 MB of the 2.7 MB initial payload,
 *    is loaded eagerly, and is the LCP element — it is the dominant contributor
 *    to the measured 3.9s LCP."
 *
 * Every rule below is written to produce the second shape: name the specific
 * resource, quantify its contribution, and connect it to a measured metric.
 */

import { fingerprint, truncate } from '@webqa/shared';
import type { NetworkObservation, RawFinding } from '@webqa/shared';
import { formatBytes, formatMs, occurrence, type PageRule } from './types.js';

/** Core Web Vitals thresholds, per web.dev. "Good" / "needs improvement" / "poor". */
const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  fcp: { good: 1800, poor: 3000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
  ttfb: { good: 800, poor: 1800 },
  tbt: { good: 200, poor: 600 },
};

export const lcpRule: PageRule = {
  id: 'performance.lcp',
  description: 'Largest Contentful Paint above the recommended threshold',
  run({ page }) {
    const lcp = page.vitals?.lcpMs;
    if (lcp === null || lcp === undefined || lcp <= THRESHOLDS.lcp.good) return [];

    const isPoor = lcp > THRESHOLDS.lcp.poor;
    const element = page.vitals?.lcpElement ?? null;
    const resourceUrl = page.vitals?.lcpResourceUrl ?? null;

    // Find the actual bytes behind the LCP element — this is what turns a
    // score into an instruction.
    const lcpRequest = resourceUrl
      ? page.requests.find((request) => request.url === resourceUrl || request.url.startsWith(resourceUrl.split('?')[0] ?? ''))
      : undefined;

    const totalBytes = page.requests.reduce((sum, request) => sum + (request.transferSizeBytes ?? 0), 0);
    const lcpBytes = lcpRequest?.transferSizeBytes ?? null;
    const share = lcpBytes && totalBytes > 0 ? (lcpBytes / totalBytes) * 100 : null;

    // Was the LCP image lazily loaded? That is a specific, common mistake.
    const lcpImage = resourceUrl
      ? page.images.find((image) => image.absoluteUrl === resourceUrl)
      : undefined;
    const lazyLoadedLcp = lcpImage?.loading === 'lazy';

    const facts: RawFinding['measuredFacts'] = [
      { label: 'LCP', value: formatMs(lcp), source: 'PerformanceObserver (largest-contentful-paint)' },
      { label: 'Recommended threshold', value: '2.5 s', source: 'web.dev Core Web Vitals' },
      { label: 'TTFB', value: page.vitals?.ttfbMs !== null && page.vitals?.ttfbMs !== undefined ? formatMs(page.vitals.ttfbMs) : 'not measured', source: 'Navigation Timing API' },
      { label: 'FCP', value: page.vitals?.fcpMs !== null && page.vitals?.fcpMs !== undefined ? formatMs(page.vitals.fcpMs) : 'not measured', source: 'Paint Timing API' },
      { label: 'Total page payload', value: formatBytes(totalBytes), source: 'Chromium network stack' },
    ];

    if (element) facts.push({ label: 'LCP element', value: element, source: 'PerformanceObserver entry.element' });
    if (resourceUrl) facts.push({ label: 'LCP resource', value: truncate(resourceUrl, 160), source: 'PerformanceObserver entry.url' });
    if (lcpBytes !== null) {
      facts.push({ label: 'LCP resource size', value: formatBytes(lcpBytes), source: 'Chromium network stack' });
    }
    if (share !== null) {
      facts.push({ label: 'Share of total payload', value: `${share.toFixed(1)}%`, source: 'Computed' });
    }
    if (lcpImage) {
      facts.push({ label: 'LCP image loading attribute', value: lcpImage.loading ?? '(not set)', source: 'DOM extraction' });
    }

    // Build the inference from what we actually found, rather than a template.
    const inferenceParts: string[] = [
      `LCP measures when the largest visible element finished rendering. At ${formatMs(lcp)} this page is ${isPoor ? 'in the "poor" band' : 'above the "good" threshold'}.`,
    ];

    if (lcpBytes !== null && share !== null && share > 25) {
      inferenceParts.push(
        `The LCP element is backed by a ${formatBytes(lcpBytes)} resource, which is ${share.toFixed(0)}% of the entire page payload. Transferring those bytes is very likely the dominant term in the measurement.`,
      );
    }
    if (lazyLoadedLcp) {
      inferenceParts.push(
        'The LCP image carries `loading="lazy"`. Lazy loading defers the request until the browser has done layout, which delays precisely the element the metric is measuring — for an above-the-fold LCP element this reliably makes LCP worse.',
      );
    }
    if (page.vitals?.ttfbMs !== null && page.vitals?.ttfbMs !== undefined && page.vitals.ttfbMs > THRESHOLDS.ttfb.poor) {
      inferenceParts.push(
        `TTFB alone is ${formatMs(page.vitals.ttfbMs)}, so ${((page.vitals.ttfbMs / lcp) * 100).toFixed(0)}% of the LCP time elapses before the browser receives a single byte of HTML. Frontend optimisation cannot recover that portion — it is server or network time.`,
      );
    }

    const recommendations: string[] = [];
    if (lazyLoadedLcp) {
      recommendations.push('Remove `loading="lazy"` from the LCP image and add `fetchpriority="high"`.');
    }
    if (lcpBytes !== null && lcpBytes > 200_000) {
      recommendations.push(
        `Compress and resize the LCP resource — at ${formatBytes(lcpBytes)} it is far above what a hero image needs. Serving AVIF or WebP at the displayed dimensions typically cuts 70–90% of those bytes.`,
      );
    }
    if (resourceUrl) {
      recommendations.push(`Add \`<link rel="preload" as="image" href="${truncate(resourceUrl, 100)}">\` so the request starts during HTML parsing rather than after layout.`);
    }
    if (page.vitals?.ttfbMs !== null && page.vitals?.ttfbMs !== undefined && page.vitals.ttfbMs > THRESHOLDS.ttfb.good) {
      recommendations.push('Reduce TTFB with server-side caching or a CDN — no amount of frontend work can offset slow origin response time.');
    }
    if (recommendations.length === 0) {
      recommendations.push('Profile the load with a DevTools performance trace to identify what delays the largest element.');
    }

    return [
      {
        ruleId: 'performance.lcp',
        fingerprint: fingerprint('performance.lcp', element ?? 'unknown'),
        title: isPoor
          ? `Largest Contentful Paint is ${formatMs(lcp)} (poor)`
          : `Largest Contentful Paint is ${formatMs(lcp)} (needs improvement)`,
        category: 'PERFORMANCE',
        severity: isPoor ? 'HIGH' : 'MEDIUM',
        // The number is measured; the causal story is inference, and it is
        // labelled as such in its own field.
        confidence: 'CONFIRMED',
        description: `The largest visible element takes ${formatMs(lcp)} to render, above the ${formatMs(THRESHOLDS.lcp.good)} threshold for a good experience.`,
        measuredFacts: facts,
        inference: inferenceParts.join(' '),
        technicalDetails: [
          `LCP element: ${element ?? 'not identified'}`,
          resourceUrl ? `LCP resource: ${resourceUrl}` : null,
          lcpBytes !== null ? `Resource transfer size: ${formatBytes(lcpBytes)}` : null,
          `Page payload: ${formatBytes(totalBytes)} across ${page.requests.length} requests`,
          `FCP: ${page.vitals?.fcpMs ? formatMs(page.vitals.fcpMs) : 'n/a'} · TTFB: ${page.vitals?.ttfbMs ? formatMs(page.vitals.ttfbMs) : 'n/a'}`,
        ].filter(Boolean).join('\n'),
        impact: isPoor
          ? 'Users perceive the page as slow to become useful. LCP is a Core Web Vital and directly affects Google search ranking, and slow LCP correlates strongly with bounce rate on mobile connections.'
          : 'The page renders its main content later than the recommended budget, which is noticeable on slower connections and counts against Core Web Vitals assessment.',
        recommendation: recommendations.join(' '),
        estimatedEffort: lazyLoadedLcp ? 'TRIVIAL' : 'MEDIUM',
        standardsRef: 'Core Web Vitals — Largest Contentful Paint',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            selector: element,
            detail: `LCP ${formatMs(lcp)}${lcpBytes !== null ? `, resource ${formatBytes(lcpBytes)}` : ''}`,
            screenshotKey: page.screenshots.viewportKey,
            inlineEvidence: {
              kind: 'METRIC',
              caption: 'Core Web Vitals measured on this page',
              data: page.vitals,
            },
          }),
        ],
      },
    ];
  },
};

export const clsRule: PageRule = {
  id: 'performance.cls',
  description: 'Cumulative Layout Shift above the recommended threshold',
  run({ page }) {
    const cls = page.vitals?.cls;
    if (cls === null || cls === undefined || cls <= THRESHOLDS.cls.good) return [];

    const isPoor = cls > THRESHOLDS.cls.poor;
    const sources = page.vitals?.clsSources ?? [];

    // Images without explicit dimensions are the classic CLS cause.
    const unsizedImages = page.images.filter(
      (image) => image.naturalWidth !== null && (image.width === null || image.height === null),
    );

    return [
      {
        ruleId: 'performance.cls',
        fingerprint: fingerprint('performance.cls'),
        title: `Cumulative Layout Shift is ${cls.toFixed(3)} (${isPoor ? 'poor' : 'needs improvement'})`,
        category: 'UI_UX',
        severity: isPoor ? 'HIGH' : 'MEDIUM',
        confidence: 'CONFIRMED',
        description: `Content moves around during load, accumulating a layout shift score of ${cls.toFixed(3)} against a ${THRESHOLDS.cls.good} threshold.`,
        measuredFacts: [
          { label: 'CLS', value: cls.toFixed(3), source: 'PerformanceObserver (layout-shift)' },
          { label: 'Recommended threshold', value: '0.1', source: 'web.dev Core Web Vitals' },
          { label: 'Shifting elements identified', value: sources.length, source: 'PerformanceObserver entry.sources' },
          { label: 'Images without explicit dimensions', value: unsizedImages.length, source: 'DOM extraction' },
        ],
        inference: [
          'Layout shift happens when content that has already been painted moves because something above it changed size — typically an image, font, or ad loading in after first paint and pushing everything down.',
          sources.length > 0 ? `The browser attributed the largest shifts to: ${sources.slice(0, 5).join(', ')}.` : '',
          unsizedImages.length > 0
            ? `${unsizedImages.length} image(s) on this page have no width/height attributes, so the browser cannot reserve space for them before they load — a direct and very common cause of exactly this metric.`
            : '',
        ].filter(Boolean).join(' '),
        technicalDetails: [
          `CLS: ${cls.toFixed(4)}`,
          sources.length > 0 ? `Shift sources: ${sources.join(', ')}` : null,
          unsizedImages.length > 0
            ? `Unsized images:\n${unsizedImages.slice(0, 8).map((i) => `  ${i.selector} (natural ${i.naturalWidth}×${i.naturalHeight})`).join('\n')}`
            : null,
        ].filter(Boolean).join('\n'),
        impact:
          'Users lose their place while reading, and mis-taps happen when a button moves between the moment a user aims and the moment they touch. On mobile this frequently results in accidentally tapping the wrong control.',
        recommendation: [
          unsizedImages.length > 0
            ? 'Set explicit `width` and `height` attributes (or a CSS `aspect-ratio`) on every image so the browser reserves the correct space before the bytes arrive.'
            : '',
          'Reserve space for any content injected after load — ads, embeds, banners — with a min-height on the container.',
          'For web fonts, use `font-display: optional` or preload the font file so text does not re-flow when the custom face swaps in.',
        ].filter(Boolean).join(' '),
        estimatedEffort: 'SMALL',
        standardsRef: 'Core Web Vitals — Cumulative Layout Shift',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `CLS ${cls.toFixed(3)}${sources.length > 0 ? `, sources: ${sources.slice(0, 3).join(', ')}` : ''}`,
            screenshotKey: page.screenshots.viewportKey,
            inlineEvidence: { kind: 'METRIC', caption: 'Layout shift measurement', data: { cls, sources } },
          }),
        ],
      },
    ];
  },
};

export const ttfbRule: PageRule = {
  id: 'performance.ttfb',
  description: 'Server response time above the recommended threshold',
  run({ page }) {
    const ttfb = page.vitals?.ttfbMs;
    if (ttfb === null || ttfb === undefined || ttfb <= THRESHOLDS.ttfb.good) return [];

    const isPoor = ttfb > THRESHOLDS.ttfb.poor;
    const document = page.requests.find((request) => request.resourceKind === 'document');
    const cacheControl = document?.responseHeaders['cache-control'] ?? null;
    const server = document?.responseHeaders['server'] ?? null;

    return [
      {
        ruleId: 'performance.ttfb',
        fingerprint: fingerprint('performance.ttfb'),
        title: `Server response time (TTFB) is ${formatMs(ttfb)}`,
        category: 'PERFORMANCE',
        severity: isPoor ? 'HIGH' : 'MEDIUM',
        confidence: 'CONFIRMED',
        description: `The browser waited ${formatMs(ttfb)} for the first byte of the HTML document.`,
        measuredFacts: [
          { label: 'TTFB', value: formatMs(ttfb), source: 'Navigation Timing API (responseStart)' },
          { label: 'Recommended threshold', value: '800 ms', source: 'web.dev' },
          { label: 'Cache-Control on document', value: cacheControl ?? '(not set)', source: 'Response headers' },
          ...(server ? [{ label: 'Server', value: server, source: 'Response headers' }] : []),
          ...(page.navigation?.redirectChain.length
            ? [{ label: 'Redirects before document', value: page.navigation.redirectChain.length, source: 'Navigation observation' }]
            : []),
        ],
        inference: [
          'TTFB is the time from navigation start until the first byte of HTML arrives. It is composed of DNS, connection setup, TLS, request travel, server processing, and response travel — none of which frontend code can influence.',
          (page.navigation?.redirectChain.length ?? 0) > 0
            ? `This page went through ${page.navigation!.redirectChain.length} redirect(s) before serving content; each one costs a full round trip and is included in the measurement above.`
            : '',
          'Because every other metric on the page starts counting from here, TTFB sets a floor that no amount of asset optimisation can go below.',
        ].filter(Boolean).join(' '),
        technicalDetails: [
          `TTFB: ${formatMs(ttfb)}`,
          page.navigation?.redirectChain.length
            ? `Redirect chain:\n${page.navigation.redirectChain.map((hop) => `  ${hop.status} → ${hop.url}`).join('\n')}`
            : null,
          `Document Cache-Control: ${cacheControl ?? 'not set'}`,
        ].filter(Boolean).join('\n'),
        impact:
          'Every visitor waits this long before anything at all can render. It is the single largest fixed cost in the page load and it affects first-time and returning visitors alike.',
        recommendation: [
          (page.navigation?.redirectChain.length ?? 0) > 0
            ? 'Eliminate the redirect(s) before the document by linking directly to the final URL and configuring the canonical host at the edge.'
            : '',
          'Add full-page or fragment caching at the origin so repeat requests are not recomputed, and put a CDN in front so the response is served from a point of presence near the user.',
          !cacheControl ? 'Set an explicit `Cache-Control` header on the document so intermediaries know what they may cache.' : '',
        ].filter(Boolean).join(' '),
        estimatedEffort: 'MEDIUM',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `TTFB ${formatMs(ttfb)}`,
            inlineEvidence: { kind: 'METRIC', caption: 'Navigation timing', data: page.navigation?.timing },
          }),
        ],
      },
    ];
  },
};

export const payloadRule: PageRule = {
  id: 'performance.payload',
  description: 'Excessive page weight',
  run({ page }) {
    const byKind = new Map<string, { bytes: number; count: number; largest: NetworkObservation | null }>();
    let totalBytes = 0;

    for (const request of page.requests) {
      const bytes = request.transferSizeBytes ?? 0;
      totalBytes += bytes;
      const entry = byKind.get(request.resourceKind) ?? { bytes: 0, count: 0, largest: null };
      entry.bytes += bytes;
      entry.count += 1;
      if (!entry.largest || bytes > (entry.largest.transferSizeBytes ?? 0)) entry.largest = request;
      byKind.set(request.resourceKind, entry);
    }

    // 2 MB is a generous budget; below that, weight is rarely the main problem.
    if (totalBytes < 2_000_000) return [];

    const sorted = [...byKind.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
    const dominant = sorted[0];
    const largestSingle = page.requests
      .slice()
      .sort((a, b) => (b.transferSizeBytes ?? 0) - (a.transferSizeBytes ?? 0))[0];

    const thirdPartyBytes = page.requests
      .filter((request) => request.isThirdParty)
      .reduce((sum, request) => sum + (request.transferSizeBytes ?? 0), 0);

    return [
      {
        ruleId: 'performance.payload',
        fingerprint: fingerprint('performance.payload'),
        title: `Page weighs ${formatBytes(totalBytes)} across ${page.requests.length} requests`,
        category: 'PERFORMANCE',
        severity: totalBytes > 5_000_000 ? 'HIGH' : 'MEDIUM',
        confidence: 'CONFIRMED',
        description: `The page transfers ${formatBytes(totalBytes)} to render, dominated by ${dominant?.[0] ?? 'unknown'} resources.`,
        measuredFacts: [
          { label: 'Total transferred', value: formatBytes(totalBytes), source: 'Chromium network stack' },
          { label: 'Requests', value: page.requests.length, source: 'Chromium network stack' },
          ...sorted.slice(0, 5).map(([kind, entry]) => ({
            label: `${kind} (${entry.count} request${entry.count === 1 ? '' : 's'})`,
            value: formatBytes(entry.bytes),
            source: 'Chromium network stack',
          })),
          ...(largestSingle
            ? [{ label: 'Largest single resource', value: `${formatBytes(largestSingle.transferSizeBytes ?? 0)} — ${truncate(pathOf(largestSingle.url), 100)}`, source: 'Chromium network stack' }]
            : []),
          { label: 'Third-party bytes', value: `${formatBytes(thirdPartyBytes)} (${totalBytes > 0 ? ((thirdPartyBytes / totalBytes) * 100).toFixed(0) : 0}%)`, source: 'Computed from request hosts' },
        ],
        inference: [
          `On a slow 4G connection (~1.6 Mbps) this payload alone takes roughly ${(totalBytes / (1_638_000 / 8) ).toFixed(1)} seconds to transfer, before any parsing or rendering.`,
          dominant ? `${dominant[0]} accounts for ${formatBytes(dominant[1].bytes)} — ${((dominant[1].bytes / totalBytes) * 100).toFixed(0)}% of the total — so that is where the leverage is.` : '',
          thirdPartyBytes / totalBytes > 0.4
            ? `Third-party resources are ${((thirdPartyBytes / totalBytes) * 100).toFixed(0)}% of the weight, which means a large share of the load time is under someone else's control.`
            : '',
        ].filter(Boolean).join(' '),
        technicalDetails: sorted
          .map(([kind, entry]) => `${kind.padEnd(12)} ${formatBytes(entry.bytes).padStart(10)}  (${entry.count} requests)${entry.largest ? `  largest: ${truncate(pathOf(entry.largest.url), 60)}` : ''}`)
          .join('\n'),
        impact:
          'Longer load times on every connection, and materially longer on mobile networks. Users on metered connections also pay for these bytes directly.',
        recommendation: [
          dominant?.[0] === 'image'
            ? 'Serve images in AVIF/WebP at the dimensions they are displayed at, and use responsive `srcset` so mobile devices do not download desktop-sized assets.'
            : '',
          dominant?.[0] === 'script'
            ? 'Code-split the JavaScript bundle so each route ships only what it needs, and defer anything not required for first render.'
            : '',
          thirdPartyBytes / totalBytes > 0.3
            ? 'Audit third-party scripts: load non-essential tags asynchronously after first paint, and remove any whose value does not justify their weight.'
            : '',
          'Enable Brotli compression at the edge for all text-based resources if it is not already active.',
        ].filter(Boolean).join(' '),
        estimatedEffort: 'MEDIUM',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `${formatBytes(totalBytes)} across ${page.requests.length} requests`,
            inlineEvidence: {
              kind: 'METRIC',
              caption: 'Payload composition by resource type',
              data: Object.fromEntries(sorted.map(([kind, entry]) => [kind, { bytes: entry.bytes, count: entry.count }])),
            },
          }),
        ],
      },
    ];
  },
};

export const unusedCodeRule: PageRule = {
  id: 'performance.unused-code',
  description: 'Large volumes of JavaScript or CSS never executed',
  run({ page }) {
    if (page.coverage.length === 0) return [];

    const findings: RawFinding[] = [];

    for (const kind of ['script', 'stylesheet'] as const) {
      const entries = page.coverage.filter((entry) => entry.kind === kind);
      if (entries.length === 0) continue;

      const totalBytes = entries.reduce((sum, entry) => sum + entry.totalBytes, 0);
      const unusedBytes = entries.reduce((sum, entry) => sum + (entry.totalBytes - entry.usedBytes), 0);
      if (unusedBytes < 100_000) continue;

      const ratio = totalBytes > 0 ? unusedBytes / totalBytes : 0;
      if (ratio < 0.4) continue;

      const worst = entries
        .slice()
        .sort((a, b) => (b.totalBytes - b.usedBytes) - (a.totalBytes - a.usedBytes))
        .slice(0, 5);

      const label = kind === 'script' ? 'JavaScript' : 'CSS';

      findings.push({
        ruleId: `performance.unused-${kind}`,
        fingerprint: fingerprint(`performance.unused-${kind}`),
        title: `${formatBytes(unusedBytes)} of ${label} is never used (${(ratio * 100).toFixed(0)}%)`,
        category: 'PERFORMANCE',
        severity: unusedBytes > 500_000 ? 'MEDIUM' : 'LOW',
        confidence: 'LIKELY',
        description: `${(ratio * 100).toFixed(0)}% of the ${label} delivered to this page was never executed during load.`,
        measuredFacts: [
          { label: `Total ${label}`, value: formatBytes(totalBytes), source: 'Chromium coverage API' },
          { label: 'Unused', value: `${formatBytes(unusedBytes)} (${(ratio * 100).toFixed(0)}%)`, source: 'Chromium coverage API' },
          ...worst.map((entry) => ({
            label: truncate(pathOf(entry.url), 70),
            value: `${formatBytes(entry.totalBytes - entry.usedBytes)} unused of ${formatBytes(entry.totalBytes)}`,
            source: 'Chromium coverage API',
          })),
        ],
        inference:
          kind === 'script'
            ? 'Coverage measures bytes that were parsed but whose code never ran during the load. Unused JavaScript still costs download, parse, and compile time on the main thread even though it does nothing. Note that coverage is a snapshot of one page load — code that only runs on user interaction will legitimately appear unused here, so treat this as a strong hint rather than a precise figure.'
            : 'Coverage measures CSS rules that matched no element on the page. Unused CSS still has to be downloaded and parsed, and a large stylesheet delays first paint because CSS is render-blocking. As with JavaScript, rules that apply only to other pages or to interactive states will appear unused in a single-page measurement.',
        technicalDetails: worst
          .map((entry) => `${truncate(entry.url, 90)}\n  ${formatBytes(entry.totalBytes)} total, ${(entry.unusedRatio * 100).toFixed(0)}% unused`)
          .join('\n'),
        impact:
          kind === 'script'
            ? 'Extra download and main-thread parse time on every page load, which delays interactivity.'
            : 'Extra render-blocking bytes, which delays first paint.',
        recommendation:
          kind === 'script'
            ? 'Split the bundle by route and lazily import features that are not needed for first render. Confirm tree-shaking is working — a large unused share often means a library is being imported wholesale rather than by named export.'
            : 'Split CSS per route or component, and inline only the critical above-the-fold rules in the document head with the rest loaded asynchronously.',
        estimatedEffort: 'MEDIUM',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `${formatBytes(unusedBytes)} unused of ${formatBytes(totalBytes)}`,
            inlineEvidence: { kind: 'METRIC', caption: `${label} coverage`, data: worst },
          }),
        ],
      });
    }

    return findings;
  },
};

export const renderBlockingRule: PageRule = {
  id: 'performance.render-blocking',
  description: 'Render-blocking resources in the document head',
  run({ page }) {
    // Stylesheets and synchronous scripts requested very early block rendering.
    const blocking = page.requests.filter(
      (request) =>
        (request.resourceKind === 'stylesheet' || request.resourceKind === 'script') &&
        request.startedAtMs < 1500 &&
        (request.transferSizeBytes ?? 0) > 20_000,
    );

    if (blocking.length < 3) return [];

    const totalBytes = blocking.reduce((sum, request) => sum + (request.transferSizeBytes ?? 0), 0);
    const fcp = page.vitals?.fcpMs;

    return [
      {
        ruleId: 'performance.render-blocking',
        fingerprint: fingerprint('performance.render-blocking'),
        title: `${blocking.length} render-blocking resources delay first paint`,
        category: 'PERFORMANCE',
        severity: 'MEDIUM',
        confidence: 'LIKELY',
        description: `${blocking.length} stylesheets and scripts totalling ${formatBytes(totalBytes)} are requested before first paint.`,
        measuredFacts: [
          { label: 'Render-blocking resources', value: blocking.length, source: 'Chromium network stack' },
          { label: 'Combined size', value: formatBytes(totalBytes), source: 'Chromium network stack' },
          ...(fcp !== null && fcp !== undefined ? [{ label: 'Measured FCP', value: formatMs(fcp), source: 'Paint Timing API' }] : []),
          ...blocking.slice(0, 5).map((request) => ({
            label: truncate(pathOf(request.url), 70),
            value: formatBytes(request.transferSizeBytes ?? 0),
            source: 'Chromium network stack',
          })),
        ],
        inference:
          'A stylesheet in the document head blocks rendering until it has downloaded and parsed, and a script without `async` or `defer` blocks HTML parsing entirely. Each of these resources therefore contributes directly to the delay before anything appears on screen. This rule is heuristic — it identifies resources requested early and large enough to matter, rather than reading the document structure — so verify against a DevTools trace before acting.',
        technicalDetails: blocking
          .slice(0, 10)
          .map((request) => `${request.resourceKind.padEnd(11)} ${formatBytes(request.transferSizeBytes ?? 0).padStart(9)}  ${truncate(request.url, 80)}`)
          .join('\n'),
        impact: 'Users stare at a blank page for longer than necessary before any content appears.',
        recommendation:
          'Add `defer` to scripts that do not need to run during parsing. Inline the critical CSS needed for above-the-fold content and load the remainder with a non-blocking pattern. Where a third-party stylesheet is blocking, self-host it or load it asynchronously.',
        estimatedEffort: 'MEDIUM',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `${blocking.length} resources, ${formatBytes(totalBytes)}`,
            inlineEvidence: {
              kind: 'NETWORK_REQUEST',
              caption: 'Resources requested before first paint',
              data: blocking.slice(0, 10).map((r) => ({ url: r.url, kind: r.resourceKind, bytes: r.transferSizeBytes, startedAtMs: r.startedAtMs })),
            },
          }),
        ],
      },
    ];
  },
};

export const cachingRule: PageRule = {
  id: 'performance.caching',
  description: 'Static assets served without a long cache lifetime',
  run({ page }) {
    const staticKinds = new Set(['script', 'stylesheet', 'image', 'font']);
    const uncached = page.requests.filter((request) => {
      if (!staticKinds.has(request.resourceKind)) return false;
      if (request.isThirdParty) return false;
      const cacheControl = request.responseHeaders['cache-control'];
      if (!cacheControl) return true;
      if (/no-store|no-cache|max-age=0/i.test(cacheControl)) return true;
      const maxAge = /max-age=(\d+)/i.exec(cacheControl);
      // Less than a day is effectively uncached for a static asset.
      return maxAge ? Number(maxAge[1]) < 86_400 : true;
    });

    if (uncached.length < 3) return [];

    const bytes = uncached.reduce((sum, request) => sum + (request.transferSizeBytes ?? 0), 0);

    return [
      {
        ruleId: 'performance.caching',
        fingerprint: fingerprint('performance.caching'),
        title: `${uncached.length} static assets lack a long cache lifetime`,
        category: 'PERFORMANCE',
        severity: 'MEDIUM',
        confidence: 'CONFIRMED',
        description: `${uncached.length} first-party static resources (${formatBytes(bytes)}) are served without an effective Cache-Control lifetime.`,
        measuredFacts: [
          { label: 'Assets affected', value: uncached.length, source: 'Response headers' },
          { label: 'Bytes re-downloaded per visit', value: formatBytes(bytes), source: 'Chromium network stack' },
          ...uncached.slice(0, 5).map((request) => ({
            label: truncate(pathOf(request.url), 70),
            value: request.responseHeaders['cache-control'] ?? '(no Cache-Control)',
            source: 'Response headers',
          })),
        ],
        inference:
          'Without a long `max-age`, the browser must revalidate or re-download these assets on every visit. For fingerprinted build outputs — filenames containing a content hash — this is pure waste: the content can never change under a given URL, so it is safe to cache indefinitely.',
        technicalDetails: uncached
          .slice(0, 12)
          .map((request) => `${truncate(pathOf(request.url), 70).padEnd(72)} ${request.responseHeaders['cache-control'] ?? '(none)'}`)
          .join('\n'),
        impact:
          'Repeat visitors re-download assets that have not changed, making the second visit almost as slow as the first and consuming bandwidth unnecessarily.',
        recommendation:
          'Serve fingerprinted assets with `Cache-Control: public, max-age=31536000, immutable`. For assets whose URL is stable across deploys, use a shorter max-age with `stale-while-revalidate` so the browser can serve instantly while refreshing in the background.',
        estimatedEffort: 'SMALL',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `${uncached.length} assets without effective caching`,
            inlineEvidence: {
              kind: 'HEADERS',
              caption: 'Cache-Control headers on static assets',
              data: uncached.slice(0, 10).map((r) => ({ url: r.url, cacheControl: r.responseHeaders['cache-control'] ?? null })),
            },
          }),
        ],
      },
    ];
  },
};

export const compressionRule: PageRule = {
  id: 'performance.compression',
  description: 'Text resources served without compression',
  run({ page }) {
    const textKinds = new Set(['script', 'stylesheet', 'document', 'xhr', 'fetch']);
    const uncompressed = page.requests.filter((request) => {
      if (!textKinds.has(request.resourceKind)) return false;
      if ((request.transferSizeBytes ?? 0) < 10_000) return false;
      const encoding = request.responseHeaders['content-encoding'];
      return !encoding || !/gzip|br|deflate|zstd/i.test(encoding);
    });

    if (uncompressed.length === 0) return [];

    const bytes = uncompressed.reduce((sum, request) => sum + (request.transferSizeBytes ?? 0), 0);
    // Text compresses roughly 4:1 with Brotli.
    const estimatedSaving = Math.round(bytes * 0.72);

    return [
      {
        ruleId: 'performance.compression',
        fingerprint: fingerprint('performance.compression'),
        title: `${uncompressed.length} text resources are served uncompressed`,
        category: 'PERFORMANCE',
        severity: 'MEDIUM',
        confidence: 'CONFIRMED',
        description: `${formatBytes(bytes)} of text content is delivered without gzip or Brotli compression.`,
        measuredFacts: [
          { label: 'Uncompressed resources', value: uncompressed.length, source: 'Content-Encoding response header' },
          { label: 'Current transfer size', value: formatBytes(bytes), source: 'Chromium network stack' },
          { label: 'Estimated size with Brotli', value: formatBytes(bytes - estimatedSaving), source: 'Estimated at ~72% reduction for text' },
          ...uncompressed.slice(0, 5).map((request) => ({
            label: truncate(pathOf(request.url), 70),
            value: formatBytes(request.transferSizeBytes ?? 0),
            source: 'Chromium network stack',
          })),
        ],
        inference:
          'No `Content-Encoding` header was present on these responses, meaning the server sent the raw bytes. Text compresses extremely well — typically 70–80% with Brotli — so this is one of the few optimisations that is both large and essentially free. The saving figure above is an estimate based on typical text compression ratios, not a measurement.',
        technicalDetails: uncompressed
          .slice(0, 12)
          .map((request) => `${formatBytes(request.transferSizeBytes ?? 0).padStart(10)}  ${truncate(request.url, 90)}`)
          .join('\n'),
        impact: `Roughly ${formatBytes(estimatedSaving)} of unnecessary transfer on every uncached page load, felt most on mobile connections.`,
        recommendation:
          'Enable Brotli (with gzip fallback) for all text MIME types at the CDN or reverse proxy. This is usually a one-line configuration change in nginx, Cloudflare, or your hosting provider.',
        estimatedEffort: 'TRIVIAL',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `${formatBytes(bytes)} uncompressed`,
            inlineEvidence: {
              kind: 'HEADERS',
              caption: 'Resources served without Content-Encoding',
              data: uncompressed.slice(0, 10).map((r) => ({ url: r.url, bytes: r.transferSizeBytes })),
            },
          }),
        ],
      },
    ];
  },
};

export const longTaskRule: PageRule = {
  id: 'performance.long-tasks',
  description: 'Main-thread blocking during load',
  run({ page }) {
    const tbt = page.vitals?.tbtMs;
    if (tbt === null || tbt === undefined || tbt <= THRESHOLDS.tbt.good) return [];

    const tasks = page.longTasks;
    const longest = tasks.slice().sort((a, b) => b.durationMs - a.durationMs)[0];

    return [
      {
        ruleId: 'performance.long-tasks',
        fingerprint: fingerprint('performance.long-tasks'),
        title: `Main thread blocked for ${formatMs(tbt)} during load`,
        category: 'PERFORMANCE',
        severity: tbt > THRESHOLDS.tbt.poor ? 'HIGH' : 'MEDIUM',
        confidence: 'CONFIRMED',
        description: `Total Blocking Time is ${formatMs(tbt)} across ${tasks.length} long task(s), against a ${THRESHOLDS.tbt.good}ms budget.`,
        measuredFacts: [
          { label: 'Total Blocking Time', value: formatMs(tbt), source: 'PerformanceObserver (longtask), TBT definition' },
          { label: 'Long tasks (>50 ms)', value: tasks.length, source: 'PerformanceObserver (longtask)' },
          ...(longest ? [{ label: 'Longest single task', value: formatMs(longest.durationMs), source: 'PerformanceObserver (longtask)' }] : []),
          ...(longest?.attribution ? [{ label: 'Attributed to', value: longest.attribution, source: 'Long task attribution' }] : []),
        ],
        inference:
          'The browser runs JavaScript on the same thread that handles clicks, scrolling, and rendering. Any task longer than 50 ms makes the page unresponsive for its duration — a click during that window is queued, not dropped, so the user experiences a delay rather than a failure. Total Blocking Time sums the portion of each long task beyond 50 ms, which is why it maps closely to perceived jank.',
        technicalDetails: tasks
          .slice()
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, 10)
          .map((task) => `${formatMs(task.durationMs).padStart(9)} at ${formatMs(task.startTimeMs)}${task.attribution ? ` — ${task.attribution}` : ''}`)
          .join('\n'),
        impact:
          'Clicks and taps feel laggy or unresponsive during load. On lower-powered devices — where CPU is several times slower than a development machine — these durations multiply.',
        recommendation:
          'Take a DevTools performance profile and look at the longest tasks first. Common fixes: defer non-critical third-party scripts until after load, break large synchronous work into chunks with `scheduler.yield()` or `setTimeout`, and move heavy computation into a Web Worker.',
        estimatedEffort: 'LARGE',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `TBT ${formatMs(tbt)} across ${tasks.length} long tasks`,
            inlineEvidence: { kind: 'METRIC', caption: 'Long tasks recorded during load', data: tasks.slice(0, 20) },
          }),
        ],
      },
    ];
  },
};

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

export const performancePageRules: PageRule[] = [
  lcpRule,
  clsRule,
  ttfbRule,
  payloadRule,
  unusedCodeRule,
  renderBlockingRule,
  cachingRule,
  compressionRule,
  longTaskRule,
];
