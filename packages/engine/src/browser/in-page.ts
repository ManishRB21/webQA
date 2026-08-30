/**
 * Scripts that execute inside the audited page.
 *
 * Two hard constraints shape everything here:
 *
 *   1. These functions are serialized and re-evaluated in the browser, so they
 *      cannot close over anything from the module scope. Every dependency is
 *      passed as an argument or defined inline.
 *
 *   2. They run on hostile ground. An audited page can have redefined
 *      `Array.prototype.map`, deleted `performance`, or wrapped `querySelector`.
 *      Everything is defensive, and every block is individually try/caught so a
 *      single broken accessor cannot take the whole extraction with it.
 */

import type {
  FormObservation,
  ImageObservation,
  InteractiveElementObservation,
  LayoutObservation,
  LinkObservation,
  MetaObservation,
  WebVitalsObservation,
  LongTaskObservation,
} from '@webqa/shared';

/**
 * Injected via `addInitScript` so the observers exist before the page's own
 * scripts run. Registering LCP/CLS observers after load misses the very events
 * they exist to record.
 */
export const VITALS_INIT_SCRIPT = `
(() => {
  // Bundlers that preserve function names (esbuild's \`keepNames\`, which tsx
  // enables by default) rewrite every function declaration to call a \`__name\`
  // helper. That helper lives in the bundle, not in the audited page — so any
  // function we hand to page.evaluate() throws "__name is not defined" the
  // moment it runs. Providing a no-op shim before page scripts execute makes
  // our evaluated functions bundler-agnostic.
  if (typeof globalThis.__name !== 'function') {
    Object.defineProperty(globalThis, '__name', {
      value: function (target) { return target; },
      writable: true, configurable: true, enumerable: false
    });
  }

  const state = {
    lcpMs: null, lcpElement: null, lcpResourceUrl: null,
    cls: 0, clsSources: [],
    inpMs: null, longTasks: [], shifts: []
  };
  window.__webqaVitals = state;

  const describe = (node) => {
    if (!node || node.nodeType !== 1) return null;
    try {
      const el = node;
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      return (el.tagName || '').toLowerCase() + id + cls;
    } catch { return null; }
  };

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (!last) return;
      state.lcpMs = last.renderTime || last.loadTime || last.startTime;
      state.lcpElement = describe(last.element);
      state.lcpResourceUrl = last.url || null;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Shifts caused by a user interaction are expected and excluded from CLS.
        if (entry.hadRecentInput) continue;
        state.cls += entry.value;
        state.shifts.push(entry.value);
        for (const source of (entry.sources || [])) {
          const label = describe(source.node);
          if (label && state.clsSources.indexOf(label) === -1 && state.clsSources.length < 10) {
            state.clsSources.push(label);
          }
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (state.longTasks.length < 100) {
          state.longTasks.push({
            startTimeMs: entry.startTime,
            durationMs: entry.duration,
            attribution: (entry.attribution && entry.attribution[0] && entry.attribution[0].containerName) || null
          });
        }
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}

  try {
    // INP: the worst interaction latency observed. Only meaningful once the
    // probe has actually interacted with the page.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = entry.duration;
        if (state.inpMs === null || duration > state.inpMs) state.inpMs = duration;
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 40 });
  } catch {}
})();
`;

export interface VitalsResult {
  vitals: WebVitalsObservation;
  longTasks: LongTaskObservation[];
}

/**
 * Read the collected vitals plus navigation timing.
 * Runs after the page settles; returns nulls rather than zeros for anything
 * the browser did not report, so the report can say "not measured" honestly.
 */
export function readVitals(): VitalsResult {
  const state = (window as unknown as { __webqaVitals?: Record<string, unknown> }).__webqaVitals ?? {};

  let ttfbMs: number | null = null;
  let fcpMs: number | null = null;
  let domContentLoadedMs: number | null = null;
  let loadEventMs: number | null = null;

  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      ttfbMs = nav.responseStart > 0 ? nav.responseStart : null;
      domContentLoadedMs = nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd : null;
      loadEventMs = nav.loadEventEnd > 0 ? nav.loadEventEnd : null;
    }
  } catch { /* ignore */ }

  try {
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    if (paint) fcpMs = paint.startTime;
  } catch { /* ignore */ }

  const longTasks = (state.longTasks as LongTaskObservation[] | undefined) ?? [];

  // Total Blocking Time: the portion of each long task beyond 50ms. This is
  // the standard definition and makes our number comparable to Lighthouse's.
  const tbtMs = longTasks.reduce((sum, task) => sum + Math.max(0, task.durationMs - 50), 0);

  return {
    vitals: {
      lcpMs: (state.lcpMs as number | null) ?? null,
      lcpElement: (state.lcpElement as string | null) ?? null,
      lcpResourceUrl: (state.lcpResourceUrl as string | null) ?? null,
      fcpMs,
      cls: typeof state.cls === 'number' ? Math.round((state.cls as number) * 10000) / 10000 : null,
      clsSources: (state.clsSources as string[] | undefined) ?? [],
      inpMs: (state.inpMs as number | null) ?? null,
      ttfbMs,
      tbtMs: longTasks.length > 0 ? Math.round(tbtMs) : null,
      domContentLoadedMs,
      loadEventMs,
    },
    longTasks,
  };
}

export interface DomExtractResult {
  meta: MetaObservation;
  links: LinkObservation[];
  images: ImageObservation[];
  forms: FormObservation[];
  interactive: InteractiveElementObservation[];
  layout: LayoutObservation[];
}

/**
 * The main DOM extraction pass.
 *
 * Everything the rule engine needs about page structure is gathered in a single
 * `evaluate` call. Doing it in one round trip rather than twenty matters: each
 * `evaluate` is a CDP round trip, and at 100 pages the difference is minutes.
 */
export function extractDom(limits: { maxLinks: number; maxImages: number; maxInteractive: number }): DomExtractResult {
  // ── helpers (defined inline; this function is serialized) ────────────────

  const cssPath = (element: Element): string => {
    try {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts: string[] = [];
      let node: Element | null = element;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const parent: Element | null = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
        depth += 1;
      }
      return parts.join(' > ');
    } catch {
      return element.tagName ? element.tagName.toLowerCase() : 'unknown';
    }
  };

  const isVisible = (element: Element): boolean => {
    try {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return false;
    }
  };

  /**
   * Compute an accessible name the way a screen reader would, in priority
   * order. Not a full accname implementation, but it covers the cases that
   * matter for "does this control announce anything at all".
   */
  const accessibleName = (element: Element): string => {
    try {
      const aria = element.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();

      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (text) return text;
      }

      if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') {
        const id = element.getAttribute('id');
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label?.textContent?.trim()) return label.textContent.trim();
        }
        const wrapping = element.closest('label');
        if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
        const placeholder = element.getAttribute('placeholder');
        if (placeholder?.trim()) return placeholder.trim();
      }

      if (element.tagName === 'IMG') {
        const alt = element.getAttribute('alt');
        if (alt?.trim()) return alt.trim();
      }

      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 120);

      // A button whose only content is an image or icon.
      const img = element.querySelector('img[alt]');
      const imgAlt = img?.getAttribute('alt');
      if (imgAlt?.trim()) return imgAlt.trim();

      const title = element.getAttribute('title');
      if (title?.trim()) return title.trim();

      return '';
    } catch {
      return '';
    }
  };

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // ── meta ─────────────────────────────────────────────────────────────────

  const meta: MetaObservation = {
    title: null, titleCount: 0, description: null, canonical: null, robots: null,
    viewport: null, langAttribute: null, charset: null, openGraph: {}, twitterCard: {},
    structuredData: [], structuredDataErrors: [], headings: [], duplicateIds: [],
    landmarks: [], htmlBytes: 0, wordCount: 0,
  };

  try {
    const titles = document.querySelectorAll('title');
    meta.titleCount = titles.length;
    meta.title = titles[0]?.textContent?.trim() ?? null;
    meta.description =
      document.querySelector('meta[name="description" i]')?.getAttribute('content')?.trim() ?? null;
    meta.canonical = document.querySelector('link[rel="canonical" i]')?.getAttribute('href') ?? null;
    meta.robots = document.querySelector('meta[name="robots" i]')?.getAttribute('content') ?? null;
    meta.viewport = document.querySelector('meta[name="viewport" i]')?.getAttribute('content') ?? null;
    meta.langAttribute = document.documentElement.getAttribute('lang');
    meta.charset =
      document.querySelector('meta[charset]')?.getAttribute('charset') ??
      document.querySelector('meta[http-equiv="content-type" i]')?.getAttribute('content') ??
      null;

    for (const tag of Array.from(document.querySelectorAll('meta[property^="og:" i]'))) {
      const key = tag.getAttribute('property');
      const value = tag.getAttribute('content');
      if (key && value) meta.openGraph[key.toLowerCase()] = value.slice(0, 500);
    }
    for (const tag of Array.from(document.querySelectorAll('meta[name^="twitter:" i]'))) {
      const key = tag.getAttribute('name');
      const value = tag.getAttribute('content');
      if (key && value) meta.twitterCard[key.toLowerCase()] = value.slice(0, 500);
    }

    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json" i]'))) {
      const raw = script.textContent ?? '';
      if (!raw.trim()) continue;
      try {
        meta.structuredData.push(JSON.parse(raw));
      } catch (error) {
        meta.structuredDataErrors.push(
          error instanceof Error ? error.message.slice(0, 200) : 'invalid JSON-LD',
        );
      }
    }

    for (const heading of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 200)) {
      meta.headings.push({
        level: Number(heading.tagName.slice(1)),
        text: (heading.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      });
    }

    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const element of Array.from(document.querySelectorAll('[id]'))) {
      const id = element.getAttribute('id');
      if (!id) continue;
      if (seen.has(id)) dupes.add(id);
      seen.add(id);
    }
    meta.duplicateIds = Array.from(dupes).slice(0, 50);

    const landmarks = new Set<string>();
    for (const element of Array.from(document.querySelectorAll('header,nav,main,footer,aside,[role]'))) {
      const role = element.getAttribute('role');
      if (role) landmarks.add(role.toLowerCase());
      else landmarks.add(element.tagName.toLowerCase());
    }
    meta.landmarks = Array.from(landmarks).slice(0, 30);

    meta.htmlBytes = document.documentElement.outerHTML.length;
    meta.wordCount = (document.body?.innerText ?? '').split(/\s+/).filter(Boolean).length;
  } catch { /* partial meta is better than none */ }

  // ── links ────────────────────────────────────────────────────────────────

  const links: LinkObservation[] = [];
  try {
    const origin = window.location.origin;
    for (const anchor of Array.from(document.querySelectorAll('a')).slice(0, limits.maxLinks)) {
      const href = anchor.getAttribute('href');
      let absoluteUrl: string | null = null;
      try {
        absoluteUrl = href ? new URL(href, document.baseURI).toString() : null;
      } catch { absoluteUrl = null; }

      const trimmed = (href ?? '').trim();
      links.push({
        href: trimmed,
        absoluteUrl,
        text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        isInternal: absoluteUrl ? absoluteUrl.startsWith(origin) : false,
        isEmptyTarget:
          trimmed === '' || trimmed === '#' || /^javascript:\s*(void\s*\(\s*0\s*\)|;)?\s*$/i.test(trimmed),
        rel: anchor.getAttribute('rel'),
        target: anchor.getAttribute('target'),
        selector: cssPath(anchor),
      });
    }
  } catch { /* ignore */ }

  // ── images ───────────────────────────────────────────────────────────────

  const images: ImageObservation[] = [];
  try {
    for (const img of Array.from(document.querySelectorAll('img')).slice(0, limits.maxImages)) {
      const rect = img.getBoundingClientRect();
      let absoluteUrl: string | null = null;
      try {
        absoluteUrl = img.currentSrc || img.src || null;
      } catch { absoluteUrl = null; }

      images.push({
        src: img.getAttribute('src'),
        absoluteUrl,
        alt: img.getAttribute('alt'),
        // Absent alt and empty alt mean different things: empty is a valid
        // declaration that the image is decorative.
        altMissing: !img.hasAttribute('alt'),
        width: rect.width || null,
        height: rect.height || null,
        naturalWidth: img.naturalWidth || null,
        naturalHeight: img.naturalHeight || null,
        loading: img.getAttribute('loading'),
        // complete && naturalWidth === 0 is the reliable "failed to decode" test.
        broken: img.complete && img.naturalWidth === 0 && Boolean(img.getAttribute('src')),
        inViewport: rect.top < viewportHeight && rect.bottom > 0 && rect.width > 0,
        selector: cssPath(img),
      });
    }
  } catch { /* ignore */ }

  // ── forms ────────────────────────────────────────────────────────────────

  const forms: FormObservation[] = [];
  try {
    for (const form of Array.from(document.querySelectorAll('form')).slice(0, 25)) {
      const fields = Array.from(form.querySelectorAll('input,select,textarea')).filter((field) => {
        const type = (field.getAttribute('type') ?? '').toLowerCase();
        return type !== 'hidden' && type !== 'submit' && type !== 'button';
      });

      const unlabeled = fields
        .filter((field) => !accessibleName(field))
        .slice(0, 20)
        .map((field) => ({
          selector: cssPath(field),
          type: (field.getAttribute('type') ?? field.tagName.toLowerCase()),
          name: field.getAttribute('name'),
        }));

      forms.push({
        selector: cssPath(form),
        action: form.getAttribute('action'),
        method: (form.getAttribute('method') ?? 'get').toLowerCase(),
        fieldCount: fields.length,
        unlabeledFields: unlabeled,
        hasSubmitControl: Boolean(
          form.querySelector('button[type="submit"], input[type="submit"], button:not([type])'),
        ),
      });
    }
  } catch { /* ignore */ }

  // ── interactive elements ─────────────────────────────────────────────────

  const interactive: InteractiveElementObservation[] = [];
  try {
    const selector =
      'button, [role="button"], a[href], input[type="submit"], input[type="button"], ' +
      '[role="tab"], [role="menuitem"], summary, [aria-expanded], [data-toggle], [onclick]';

    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, limits.maxInteractive)) {
      const rect = element.getBoundingClientRect();
      const visible = isVisible(element);

      // Hit-test the element's centre. If something else is returned, this
      // control is covered — a real and commonly-missed usability defect.
      let obscuredBy: string | null = null;
      if (visible && rect.width > 0 && rect.height > 0) {
        try {
          const centreX = rect.left + rect.width / 2;
          const centreY = rect.top + rect.height / 2;
          if (centreX >= 0 && centreX <= viewportWidth && centreY >= 0 && centreY <= viewportHeight) {
            const topElement = document.elementFromPoint(centreX, centreY);
            if (topElement && topElement !== element && !element.contains(topElement) && !topElement.contains(element)) {
              obscuredBy = cssPath(topElement);
            }
          }
        } catch { /* ignore */ }
      }

      interactive.push({
        selector: cssPath(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        accessibleName: accessibleName(element),
        visible,
        enabled: !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true',
        inViewport: rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0,
        boundingBox: rect.width > 0
          ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
          : null,
        obscuredBy,
      });
    }
  } catch { /* ignore */ }

  // ── layout problems ──────────────────────────────────────────────────────

  const layout: LayoutObservation[] = [];
  try {
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    );

    // Horizontal overflow: the classic mobile-layout failure.
    if (documentWidth > viewportWidth + 1) {
      layout.push({
        kind: 'HORIZONTAL_OVERFLOW',
        selector: 'html',
        detail: `Document is ${Math.round(documentWidth - viewportWidth)}px wider than the viewport, forcing horizontal scroll.`,
        measurements: { documentWidth, viewportWidth, overflowPx: documentWidth - viewportWidth },
      });

      // Identify the specific offenders so the finding is actionable rather
      // than "something on the page is too wide".
      let reported = 0;
      for (const element of Array.from(document.querySelectorAll('body *'))) {
        if (reported >= 5) break;
        try {
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.right > viewportWidth + 1 && rect.width <= documentWidth) {
            const style = window.getComputedStyle(element);
            if (style.position === 'fixed') continue;
            layout.push({
              kind: 'ELEMENT_OUTSIDE_VIEWPORT',
              selector: cssPath(element),
              detail: `Element extends ${Math.round(rect.right - viewportWidth)}px past the right edge of the viewport.`,
              measurements: {
                elementRight: Math.round(rect.right),
                viewportWidth,
                overflowPx: Math.round(rect.right - viewportWidth),
              },
            });
            reported += 1;
          }
        } catch { /* ignore */ }
      }
    }

    // Tap targets below the WCAG 2.5.8 minimum of 24x24 CSS pixels.
    let tinyTargets = 0;
    for (const element of Array.from(document.querySelectorAll('a[href], button, [role="button"]'))) {
      if (tinyTargets >= 10) break;
      try {
        if (!isVisible(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24)) {
          layout.push({
            kind: 'TINY_TAP_TARGET',
            selector: cssPath(element),
            detail: `Interactive target is ${Math.round(rect.width)}×${Math.round(rect.height)}px, below the 24×24px minimum.`,
            measurements: { width: Math.round(rect.width), height: Math.round(rect.height), minimum: 24 },
          });
          tinyTargets += 1;
        }
      } catch { /* ignore */ }
    }

    // Clipped text: a fixed-height box whose content overflows it.
    let clipped = 0;
    for (const element of Array.from(document.querySelectorAll('p, h1, h2, h3, span, div, li, td, button, a'))) {
      if (clipped >= 8) break;
      try {
        if (!isVisible(element)) continue;
        const style = window.getComputedStyle(element);
        if (style.overflow !== 'hidden' && style.overflowY !== 'hidden') continue;
        if (style.textOverflow === 'ellipsis') continue; // deliberate truncation
        if (element.scrollHeight > element.clientHeight + 4 && element.clientHeight > 0) {
          const text = (element.textContent ?? '').trim();
          if (!text) continue;
          clipped += 1;
          layout.push({
            kind: 'CLIPPED_TEXT',
            selector: cssPath(element),
            detail: `Content is ${element.scrollHeight - element.clientHeight}px taller than its container and is being cut off.`,
            measurements: { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight },
          });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return { meta, links, images, forms, interactive, layout };
}
