/**
 * SEO rules.
 *
 * The site-level rules here (duplicate titles, duplicate descriptions) are the
 * reason the rule engine has a site scope at all — they are undetectable from a
 * single page, and they are among the most common real problems on large sites.
 */

import { fingerprint, truncate } from '@webqa/shared';
import type { RawFinding } from '@webqa/shared';
import { occurrence, type PageRule, type SiteRule } from './types.js';

export const titleRule: PageRule = {
  id: 'seo.title',
  description: 'Missing, empty, or poorly-sized page title',
  run({ page }) {
    const meta = page.meta;
    if (!meta) return [];
    const findings: RawFinding[] = [];
    const title = meta.title?.trim() ?? '';

    if (!title) {
      findings.push({
        ruleId: 'seo.missing-title',
        fingerprint: fingerprint('seo.missing-title'),
        title: 'Page has no title',
        category: 'SEO',
        severity: 'HIGH',
        confidence: 'CONFIRMED',
        description: 'The page has no `<title>` element, or the element is empty.',
        measuredFacts: [
          { label: '<title> elements found', value: meta.titleCount, source: 'DOM extraction' },
          { label: 'Title text', value: '(empty)', source: 'DOM extraction' },
        ],
        inference:
          'The title is the single strongest on-page relevance signal for search engines, and it is what appears as the clickable headline in results, as the browser tab label, and as the default name when a user bookmarks the page. With none, search engines synthesise one from page content — usually badly.',
        technicalDetails: 'No non-empty `<title>` element present in the document head.',
        impact: 'Poor search result presentation and reduced click-through. Browser tabs and bookmarks are unidentifiable.',
        recommendation: 'Add a unique, descriptive `<title>` of roughly 50–60 characters that names the page and the site.',
        estimatedEffort: 'TRIVIAL',
        occurrences: [occurrence({ pageUrl: page.url, detail: 'No title element' })],
      });
    } else if (title.length > 65 || title.length < 15) {
      const tooLong = title.length > 65;
      findings.push({
        ruleId: 'seo.title-length',
        fingerprint: fingerprint('seo.title-length', tooLong ? 'long' : 'short'),
        title: tooLong ? 'Page titles are too long' : 'Page titles are too short',
        category: 'SEO',
        severity: 'LOW',
        confidence: 'LIKELY',
        description: `The title is ${title.length} characters, outside the 15–65 character range that displays well in search results.`,
        measuredFacts: [
          { label: 'Title length', value: `${title.length} characters`, source: 'DOM extraction' },
          { label: 'Recommended range', value: '15–65 characters', source: 'Typical SERP truncation width' },
          { label: 'Title', value: truncate(title, 120), source: 'DOM extraction' },
        ],
        inference: tooLong
          ? 'Search engines truncate titles at roughly 600 pixels, which is about 60 characters for typical text. Everything past that is replaced with an ellipsis, so any distinguishing information at the end is invisible in results.'
          : 'A very short title carries little relevance signal and gives users little reason to click.',
        technicalDetails: `Title: "${title}"\nLength: ${title.length} characters`,
        impact: 'Reduced click-through from search results; the value is presentational rather than a ranking penalty.',
        recommendation: tooLong
          ? 'Shorten to under 60 characters, putting the most distinguishing words first so they survive truncation.'
          : 'Expand the title to describe the page more specifically, including the site or brand name.',
        estimatedEffort: 'TRIVIAL',
        occurrences: [occurrence({ pageUrl: page.url, detail: `${title.length} chars: "${truncate(title, 100)}"` })],
      });
    }

    if (meta.titleCount > 1) {
      findings.push({
        ruleId: 'seo.multiple-titles',
        fingerprint: fingerprint('seo.multiple-titles'),
        title: 'Page has more than one title element',
        category: 'SEO',
        severity: 'MEDIUM',
        confidence: 'CONFIRMED',
        description: `${meta.titleCount} \`<title>\` elements were found; the document should contain exactly one.`,
        measuredFacts: [{ label: '<title> elements', value: meta.titleCount, source: 'DOM extraction' }],
        inference:
          'The HTML specification permits exactly one title element. When several are present, browsers and crawlers each pick one by their own rules, so the title you see in a browser tab may not be the one a search engine indexes.',
        technicalDetails: `Found ${meta.titleCount} title elements. First: "${truncate(title, 100)}"`,
        impact: 'Unpredictable title selection across browsers and crawlers.',
        recommendation: 'Remove the duplicates. This usually means a template or CMS plugin is injecting a second title alongside the layout\'s own.',
        estimatedEffort: 'SMALL',
        occurrences: [occurrence({ pageUrl: page.url, detail: `${meta.titleCount} title elements` })],
      });
    }

    return findings;
  },
};

export const metaDescriptionRule: PageRule = {
  id: 'seo.meta-description',
  description: 'Missing or poorly-sized meta description',
  run({ page }) {
    const meta = page.meta;
    if (!meta) return [];
    const description = meta.description?.trim() ?? '';

    if (!description) {
      return [{
        ruleId: 'seo.missing-description',
        fingerprint: fingerprint('seo.missing-description'),
        title: 'Page has no meta description',
        category: 'SEO',
        severity: 'MEDIUM',
        confidence: 'CONFIRMED',
        description: 'No `<meta name="description">` was found.',
        measuredFacts: [{ label: 'Meta description', value: '(absent)', source: 'DOM extraction' }],
        inference:
          'The meta description is not a ranking factor, but it is usually what search engines display as the snippet under the title. Without one they extract an arbitrary passage from the page, which frequently produces a fragment that reads badly and does not describe the page.',
        technicalDetails: 'No meta description element present.',
        impact: 'Lower click-through from search results, because the snippet is auto-generated and often unhelpful.',
        recommendation: 'Add a unique 120–158 character description summarising the page and giving a reason to click.',
        estimatedEffort: 'TRIVIAL',
        occurrences: [occurrence({ pageUrl: page.url, detail: 'No meta description' })],
      }];
    }

    if (description.length > 165 || description.length < 70) {
      const tooLong = description.length > 165;
      return [{
        ruleId: 'seo.description-length',
        fingerprint: fingerprint('seo.description-length', tooLong ? 'long' : 'short'),
        title: tooLong ? 'Meta descriptions are too long' : 'Meta descriptions are too short',
        category: 'SEO',
        severity: 'LOW',
        confidence: 'LIKELY',
        description: `The meta description is ${description.length} characters, outside the 70–160 range that displays fully.`,
        measuredFacts: [
          { label: 'Description length', value: `${description.length} characters`, source: 'DOM extraction' },
          { label: 'Recommended range', value: '70–160 characters', source: 'Typical SERP snippet width' },
        ],
        inference: tooLong
          ? 'Snippets are truncated around 155–160 characters. Content past that point is never shown.'
          : 'A very short description leaves most of the available snippet space unused.',
        technicalDetails: `Description: "${truncate(description, 250)}"`,
        impact: 'Reduced click-through; presentational rather than a ranking issue.',
        recommendation: tooLong ? 'Trim to under 160 characters.' : 'Expand to make fuller use of the snippet space.',
        estimatedEffort: 'TRIVIAL',
        occurrences: [occurrence({ pageUrl: page.url, detail: `${description.length} chars` })],
      }];
    }

    return [];
  },
};

export const canonicalRule: PageRule = {
  id: 'seo.canonical',
  description: 'Missing canonical URL',
  run({ page }) {
    const meta = page.meta;
    if (!meta || meta.canonical) return [];

    return [{
      ruleId: 'seo.missing-canonical',
      fingerprint: fingerprint('seo.missing-canonical'),
      title: 'Pages have no canonical URL',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'CONFIRMED',
      description: 'No `<link rel="canonical">` was found on this page.',
      measuredFacts: [{ label: 'Canonical link', value: '(absent)', source: 'DOM extraction' }],
      inference:
        'A canonical tag tells search engines which URL is authoritative when the same content is reachable at several addresses — with and without a trailing slash, with tracking parameters, over http and https. Without one, ranking signals can be split across duplicates rather than consolidated.',
      technicalDetails: 'No canonical link element present in the document head.',
      impact: 'Potential duplicate-content dilution where the same page is reachable at multiple URLs.',
      recommendation: 'Add a self-referencing `<link rel="canonical" href="…">` with the absolute preferred URL on every indexable page.',
      estimatedEffort: 'SMALL',
      occurrences: [occurrence({ pageUrl: page.url, detail: 'No canonical link' })],
    }];
  },
};

export const viewportRule: PageRule = {
  id: 'seo.viewport',
  description: 'Missing or restrictive viewport meta tag',
  run({ page }) {
    const meta = page.meta;
    if (!meta) return [];
    const viewport = meta.viewport ?? '';

    if (!viewport) {
      return [{
        ruleId: 'seo.missing-viewport',
        fingerprint: fingerprint('seo.missing-viewport'),
        title: 'Page has no viewport meta tag',
        category: 'SEO',
        severity: 'HIGH',
        confidence: 'CONFIRMED',
        description: 'No `<meta name="viewport">` was found, so mobile browsers will render the page at desktop width and scale it down.',
        measuredFacts: [{ label: 'Viewport meta', value: '(absent)', source: 'DOM extraction' }],
        inference:
          'Without a viewport declaration, mobile browsers assume a 980px-wide desktop layout and zoom out to fit. Text becomes unreadably small and every tap target shrinks proportionally. Search engines also treat the page as not mobile-friendly, which affects mobile ranking.',
        technicalDetails: 'No viewport meta tag present.',
        impact: 'The site is effectively unusable on phones without pinch-zooming, and is penalised in mobile search.',
        recommendation: 'Add `<meta name="viewport" content="width=device-width, initial-scale=1">` to the document head.',
        estimatedEffort: 'TRIVIAL',
        standardsRef: 'WCAG 2.1 — 1.4.10 Reflow',
        occurrences: [occurrence({ pageUrl: page.url, detail: 'No viewport meta tag' })],
      }];
    }

    if (/user-scalable\s*=\s*(no|0)/i.test(viewport) || /maximum-scale\s*=\s*(1(\.0)?|0)/i.test(viewport)) {
      return [{
        ruleId: 'seo.viewport-blocks-zoom',
        fingerprint: fingerprint('seo.viewport-blocks-zoom'),
        title: 'Viewport meta tag prevents zooming',
        category: 'ACCESSIBILITY',
        severity: 'HIGH',
        confidence: 'CONFIRMED',
        description: 'The viewport tag disables pinch-to-zoom.',
        measuredFacts: [{ label: 'Viewport content', value: viewport, source: 'DOM extraction' }],
        inference:
          '`user-scalable=no` or a `maximum-scale` of 1 stops users from zooming in. For anyone with low vision, zoom is not a convenience — it is the mechanism by which the page becomes readable at all. This is an explicit WCAG failure.',
        technicalDetails: `<meta name="viewport" content="${viewport}">`,
        impact: 'Users with low vision cannot enlarge text, which can make the site entirely unusable for them.',
        recommendation: 'Remove `user-scalable=no` and any `maximum-scale` below 2. The layout problems this is usually added to hide should be fixed directly.',
        estimatedEffort: 'TRIVIAL',
        standardsRef: 'WCAG 2.1 — 1.4.4 Resize Text',
        occurrences: [occurrence({ pageUrl: page.url, detail: viewport })],
      }];
    }

    return [];
  },
};

export const langRule: PageRule = {
  id: 'seo.lang',
  description: 'Missing lang attribute on the html element',
  run({ page }) {
    if (!page.meta || page.meta.langAttribute) return [];

    return [{
      ruleId: 'seo.missing-lang',
      fingerprint: fingerprint('seo.missing-lang'),
      title: 'Document has no lang attribute',
      category: 'ACCESSIBILITY',
      severity: 'MEDIUM',
      confidence: 'CONFIRMED',
      description: 'The `<html>` element has no `lang` attribute.',
      measuredFacts: [{ label: 'html[lang]', value: '(absent)', source: 'DOM extraction' }],
      inference:
        'Screen readers use the document language to choose a pronunciation model. Without it they fall back to the user\'s system language, so English content may be read with, say, German phonetics — technically audible but very hard to follow.',
      technicalDetails: '<html> element has no lang attribute.',
      impact: 'Screen reader output can be mispronounced to the point of being unintelligible. Also affects browser translation prompts.',
      recommendation: 'Add the correct BCP 47 tag, e.g. `<html lang="en">` or `<html lang="en-GB">`.',
      estimatedEffort: 'TRIVIAL',
      standardsRef: 'WCAG 2.1 — 3.1.1 Language of Page',
      occurrences: [occurrence({ pageUrl: page.url, detail: 'No lang attribute' })],
    }];
  },
};

export const imageAltRule: PageRule = {
  id: 'seo.image-alt',
  description: 'Images missing alt attributes',
  run({ page }) {
    const missing = page.images.filter((image) => image.altMissing);
    if (missing.length === 0) return [];

    return [{
      ruleId: 'seo.image-alt',
      fingerprint: fingerprint('seo.image-alt'),
      title: 'Images are missing alt attributes',
      category: 'ACCESSIBILITY',
      severity: 'MEDIUM',
      confidence: 'CONFIRMED',
      description: `${missing.length} image(s) have no \`alt\` attribute at all.`,
      measuredFacts: [
        { label: 'Images without alt', value: missing.length, source: 'DOM extraction' },
        { label: 'Total images on page', value: page.images.length, source: 'DOM extraction' },
      ],
      inference:
        'An absent `alt` attribute is different from an empty one. `alt=""` declares the image decorative and screen readers skip it; a missing attribute leaves them nothing to work with, so most fall back to announcing the filename — which is rarely meaningful and often absurd.',
      technicalDetails: missing
        .slice(0, 12)
        .map((image) => `${image.selector} — src="${truncate(image.src ?? '', 90)}"`)
        .join('\n'),
      impact: 'Screen reader users lose whatever information the image carries. Search engines also lose the image-context signal.',
      recommendation: 'Add `alt` text describing the image\'s purpose in context. For purely decorative images, use `alt=""` explicitly — the empty value is the correct declaration, not an omission.',
      estimatedEffort: missing.length > 30 ? 'MEDIUM' : 'SMALL',
      standardsRef: 'WCAG 2.1 — 1.1.1 Non-text Content',
      occurrences: missing.slice(0, 30).map((image) =>
        occurrence({ pageUrl: page.url, selector: image.selector, detail: `src="${truncate(image.src ?? '', 120)}"` }),
      ),
    }];
  },
};

// ── Site-level ─────────────────────────────────────────────────────────────

export const duplicateTitleRule: SiteRule = {
  id: 'seo.duplicate-title',
  description: 'Multiple pages sharing the same title',
  run({ pages }) {
    const byTitle = new Map<string, string[]>();
    for (const page of pages) {
      const title = page.meta?.title?.trim();
      if (!title) continue;
      const bucket = byTitle.get(title) ?? [];
      bucket.push(page.url);
      byTitle.set(title, bucket);
    }

    const duplicates = [...byTitle.entries()].filter(([, urls]) => urls.length > 1);
    if (duplicates.length === 0) return [];

    const affected = duplicates.reduce((sum, [, urls]) => sum + urls.length, 0);

    return [{
      ruleId: 'seo.duplicate-title',
      fingerprint: fingerprint('seo.duplicate-title'),
      title: 'Multiple pages share the same title',
      category: 'SEO',
      severity: 'MEDIUM',
      confidence: 'CONFIRMED',
      description: `${duplicates.length} title(s) are used by more than one page, affecting ${affected} pages in total.`,
      measuredFacts: [
        { label: 'Duplicated titles', value: duplicates.length, source: 'Cross-page comparison' },
        { label: 'Pages affected', value: affected, source: 'Cross-page comparison' },
        ...duplicates.slice(0, 4).map(([title, urls]) => ({
          label: truncate(title, 60),
          value: `${urls.length} pages`,
          source: 'Cross-page comparison',
        })),
      ],
      inference:
        'Titles are how search engines and users tell pages apart. When several pages carry the same title, search engines have difficulty deciding which is the best result for a query, and users looking at a list of results or browser tabs cannot distinguish them. This pattern almost always means a template is emitting a static title instead of interpolating page-specific content.',
      technicalDetails: duplicates
        .slice(0, 8)
        .map(([title, urls]) => `"${truncate(title, 70)}"\n${urls.slice(0, 5).map((url) => `    ${url}`).join('\n')}${urls.length > 5 ? `\n    …and ${urls.length - 5} more` : ''}`)
        .join('\n\n'),
      impact: 'Weakened relevance signals and worse search presentation across a group of pages.',
      recommendation: 'Make each title unique by interpolating page-specific content into the template — the product name, article headline, or category, plus the site name.',
      estimatedEffort: 'SMALL',
      occurrences: duplicates.slice(0, 10).flatMap(([title, urls]) =>
        urls.slice(0, 5).map((url) => occurrence({ pageUrl: url, detail: `Title: "${truncate(title, 100)}"` })),
      ),
    }];
  },
};

export const duplicateDescriptionRule: SiteRule = {
  id: 'seo.duplicate-description',
  description: 'Multiple pages sharing the same meta description',
  run({ pages }) {
    const byDescription = new Map<string, string[]>();
    for (const page of pages) {
      const description = page.meta?.description?.trim();
      if (!description) continue;
      const bucket = byDescription.get(description) ?? [];
      bucket.push(page.url);
      byDescription.set(description, bucket);
    }

    const duplicates = [...byDescription.entries()].filter(([, urls]) => urls.length > 1);
    if (duplicates.length === 0) return [];

    const affected = duplicates.reduce((sum, [, urls]) => sum + urls.length, 0);

    return [{
      ruleId: 'seo.duplicate-description',
      fingerprint: fingerprint('seo.duplicate-description'),
      title: 'Multiple pages share the same meta description',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'CONFIRMED',
      description: `${duplicates.length} description(s) are reused across ${affected} pages.`,
      measuredFacts: [
        { label: 'Duplicated descriptions', value: duplicates.length, source: 'Cross-page comparison' },
        { label: 'Pages affected', value: affected, source: 'Cross-page comparison' },
      ],
      inference:
        'A shared description means the search snippet for each of these pages is identical, so results give the user no basis for choosing between them. As with titles, this is usually a template emitting a site-wide default.',
      technicalDetails: duplicates
        .slice(0, 5)
        .map(([description, urls]) => `"${truncate(description, 80)}"\n${urls.slice(0, 4).map((url) => `    ${url}`).join('\n')}`)
        .join('\n\n'),
      impact: 'Identical, undifferentiated snippets in search results across a group of pages.',
      recommendation: 'Generate descriptions from page content, or write them per page for the pages that matter most.',
      estimatedEffort: 'MEDIUM',
      occurrences: duplicates.slice(0, 10).flatMap(([, urls]) =>
        urls.slice(0, 4).map((url) => occurrence({ pageUrl: url, detail: 'Shared meta description' })),
      ),
    }];
  },
};

export const sitemapRule: SiteRule = {
  id: 'seo.sitemap',
  description: 'No XML sitemap discoverable',
  run({ site }) {
    const findings: RawFinding[] = [];

    if (!site.sitemap?.found) {
      findings.push({
        ruleId: 'seo.no-sitemap',
        fingerprint: fingerprint('seo.no-sitemap'),
        title: 'No XML sitemap found',
        category: 'SEO',
        severity: 'LOW',
        confidence: 'CONFIRMED',
        description: 'No sitemap was found at /sitemap.xml, /sitemap_index.xml, or referenced from robots.txt.',
        measuredFacts: [
          { label: 'sitemap.xml', value: 'not found', source: 'HTTP probe' },
          { label: 'Referenced in robots.txt', value: site.robots?.sitemapUrls.length ? 'yes' : 'no', source: 'robots.txt parse' },
        ],
        inference:
          'A sitemap gives search engines an explicit list of URLs to crawl along with change frequency hints. Without one, crawlers rely entirely on following links — so pages that are poorly linked internally, or newly published, are discovered slowly or not at all.',
        technicalDetails: 'Probed /sitemap.xml and /sitemap_index.xml; neither returned a parseable sitemap.',
        impact: 'Slower discovery and indexing of new or deeply-nested pages.',
        recommendation: 'Generate an XML sitemap and reference it from robots.txt with a `Sitemap:` directive. Most frameworks and CMSs can produce one automatically.',
        estimatedEffort: 'SMALL',
        occurrences: [occurrence({ pageUrl: site.seedUrl, detail: 'No sitemap discoverable' })],
      });
    }

    if (!site.robots?.found) {
      findings.push({
        ruleId: 'seo.no-robots',
        fingerprint: fingerprint('seo.no-robots'),
        title: 'No robots.txt found',
        category: 'SEO',
        severity: 'INFO',
        confidence: 'CONFIRMED',
        description: 'No robots.txt was served at the site root.',
        measuredFacts: [{ label: 'robots.txt', value: `not found (HTTP ${site.robots?.status ?? 'no response'})`, source: 'HTTP probe' }],
        inference:
          'robots.txt is optional — its absence means "crawl everything", which is often the correct policy for a public site. It is worth adding mainly as the conventional place to declare the sitemap location and to keep crawlers out of endpoints that waste their budget.',
        technicalDetails: `Requested ${site.origin}/robots.txt — not found.`,
        impact: 'No practical harm for most sites; a missed opportunity to guide crawlers.',
        recommendation: 'Add a robots.txt containing at minimum a `Sitemap:` directive pointing at your sitemap.',
        estimatedEffort: 'TRIVIAL',
        occurrences: [occurrence({ pageUrl: site.seedUrl, detail: 'No robots.txt' })],
      });
    }

    return findings;
  },
};

export const seoPageRules: PageRule[] = [
  titleRule,
  metaDescriptionRule,
  canonicalRule,
  viewportRule,
  langRule,
  imageAltRule,
];

export const seoSiteRules: SiteRule[] = [duplicateTitleRule, duplicateDescriptionRule, sitemapRule];
