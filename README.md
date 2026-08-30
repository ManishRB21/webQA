# webQA

An automated QA engineer for any public website. Give it a URL — it crawls the site with a real browser, clicks things, watches what breaks, and produces a self-contained HTML report.

No source code access. No database. No cloud services. One command, one HTML file out.

```bash
npm run audit -- https://example.com
```

---

## Setup

```bash
git clone <repo> && cd webQA
npm install
npx playwright install chromium
```

**Node.js >= 20.11.0 required.**

---

## Authentication

No API key needed. If you're signed into Claude Code or have run `ant auth login`, credentials are picked up automatically.

Resolution order:

| # | Source |
|---|---|
| 1 | `ANTHROPIC_API_KEY` env var |
| 2 | `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` env var |
| 3 | `ant auth login` profile |
| 4 | Claude Code IDE/CLI login (`~/.claude/.credentials.json`) |

Check which credential is active:

```bash
npm run audit -- --auth
```

To skip AI entirely:

```bash
npm run audit -- https://example.com --no-ai
```

---

## Usage

```bash
npm run audit -- <url> [options]
```

| Option | Description | Default |
|---|---|---|
| `--pages <n>` | Max pages to crawl | `25` |
| `--depth <n>` | Max crawl depth | `2` |
| `--device <profile>` | `desktop` \| `mobile` | `desktop` |
| `--network <profile>` | `fast` \| `fast-4g` \| `slow-4g` | `fast` |
| `--out <dir>` | Output directory | `./webqa-results` |
| `--no-interactions` | Skip functional click testing | |
| `--no-ai` | Deterministic findings only | |
| `--no-external-links` | Do not verify external links | |
| `--no-robots` | Ignore robots.txt | |
| `--subdomains` | Follow links to subdomains | |
| `--include <paths>` | Only crawl these path prefixes (comma-separated) | |
| `--exclude <paths>` | Never crawl these path prefixes | |
| `--quiet` | Only print the final summary | |
| `--json` | Emit machine-readable result to stdout | |

### Common recipes

```bash
# Quick look — one page, ~15 seconds
npm run audit -- yoursite.com --pages 1 --no-interactions

# Standard audit — ~5 min for 25 pages
npm run audit -- yoursite.com

# Deep audit
npm run audit -- yoursite.com --pages 100 --depth 3

# Mobile on a slow connection
npm run audit -- yoursite.com --device mobile --network slow-4g

# Just one section of the site
npm run audit -- yoursite.com --include /products --pages 50

# Fast + free: skip AI and interactions
npm run audit -- yoursite.com --no-ai --no-interactions
```

A bare host works — `yoursite.com` becomes `https://yoursite.com`.

---

## Output

Results land in `./webqa-results/<auditId>/`:

| File | What it is |
|---|---|
| `report.html` | Self-contained report — screenshots inlined, opens anywhere, prints to PDF. |
| `audit.json` | Findings, scores, and stats as structured data. For CI gates. |
| `observations.json` | Every raw observation — the audit trail behind every claim. |
| `screenshots/` | JPEG evidence captured during the run. |

---

## What it checks

- **Functional** — uncaught exceptions, failed API calls, broken images/scripts/fonts, broken links, blank pages, interaction testing (clicks controls and reports what throws, fails, or does nothing)
- **Performance** — LCP, CLS, TTFB, TBT, INP, FCP, payload composition, unused JS/CSS, render-blocking resources, cache headers, compression
- **Accessibility** — axe-core (WCAG 2.1 A/AA, 2.2 AA), heading structure, unlabeled fields, unnamed/covered controls
- **SEO** — titles, descriptions, canonicals, viewport, `lang`, alt text, sitemap/robots discovery, duplicate title/description detection
- **Security** — HTTPS, CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, clickjacking, mixed content, cookie flags, third-party scripts. Weak configs are flagged, not just missing ones.
- **UI/UX** — horizontal overflow, tap targets below 24×24px, clipped text, overlapping controls

---

## How it works

```
Probes emit OBSERVATIONS  (facts:  "POST /api/checkout returned 500 at t=3.2s")
   ↓
Rules emit FINDINGS       (claims: "Checkout is broken", with the fact attached)
   ↓
AI enriches FINDINGS      (never creates them — it only ever sees the evidence table)
```

The model never sees the website. It sees a table of measurements the deterministic layer collected. Every finding in the report traces back to a timestamped observation.

Findings are either `CONFIRMED` (failure observed directly) or `POSSIBLE` (suggestive evidence, benign explanation exists). The model can never promote `POSSIBLE` to `CONFIRMED`.

Deduplication is built in — missing alt text on 214 images is **one** finding with 214 occurrences, not 214 findings.

---

## Configuration

Copy `.env.example` to `.env` to override defaults. Everything has a working default — no changes required for a standard run.

Key options:

```env
ANTHROPIC_API_KEY=          # only needed without a Claude Code login
AI_MODEL=claude-opus-5
MAX_PAGES_HARD_LIMIT=500
CRAWL_DELAY_MS=250
SSRF_PROTECTION=true
```

---

## Development

```bash
npm test          # 171 tests, no browser required
npm run typecheck
npm run build
```

### Project structure

```
packages/
  shared/    Domain model — findings, observations, scoring, URL safety
  engine/
    browser/     Playwright session, network/console collectors
    crawl/       Priority frontier, robots + sitemap discovery
    probes/      Page probe, axe-core, interaction testing, link checker
    rules/       Observations → findings (pure functions)
    analysis/    Deduplication, priority scoring, correlation
    ai/          Anthropic provider, enrichment
    report/      Self-contained HTML generator
```

---

## Programmatic use

```ts
import { runAudit, renderHtmlReport, loadEngineConfig, Reporter, EvidenceStore } from '@webqa/engine';

const engine = loadEngineConfig({ outputDir: './out' });
const reporter = new Reporter({ verbose: false, colour: false });

reporter.onEvent((event) => console.log(event.phase, event.message));

const result = await runAudit({ url: 'https://example.com', config, engine, reporter });

if (result.scores.overall < 70) process.exit(1);
const html = await renderHtmlReport({ result, evidence: new EvidenceStore('./out') });
```

---

## Safety

- **SSRF protection** — URLs are checked syntactically then DNS-resolved; every returned address is validated against private/loopback/cloud-metadata ranges.
- **Never destructive** — skips anything whose label suggests an irreversible action (delete, logout, buy, send, etc.).
- **Passive security only** — findings come from response headers on normal page loads. No fuzzing or bypass attempts.
- **Polite** — honours `robots.txt` by default, delays between requests, caps concurrency per host.
- **Secrets never leave** — auth headers, cookies, and token-shaped strings are redacted before logging or sending to the model.

---

## Limits

- Black-box only — no source, backend, or database access
- Pages behind authentication are not tested
- Destructive-looking interactions are skipped
- One measurement per page; timing varies between runs
- Security findings are configuration observations, not a penetration test

---

## License

MIT
