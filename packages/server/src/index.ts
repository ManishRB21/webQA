import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runAudit,
  renderHtmlReport,
  loadEngineConfig,
  Reporter,
  EvidenceStore,
} from '@webqa/engine';
import type { ResolvedAuditConfig } from '@webqa/shared';

const app = express();
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN ?? '*',
  credentials: false,
}));
// Explicitly handle preflight for all routes
app.options('*', cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));
app.use(express.json());

const PORT = process.env.PORT ?? 3001;
const OUTPUT_DIR = process.env.WEBQA_OUTPUT_DIR ?? './webqa-results';

// In-memory store of completed audits (report HTML keyed by auditId)
const reports = new Map<string, string>();

// ── GET /api/audit-sse ─────────────────────────────────────────────────────
// EventSource only supports GET, so params come via query string.
app.get('/api/audit-sse', async (req, res) => {
  const { url, pages = '25', depth = '2', device = 'DESKTOP', network = 'FAST', ai = 'true', interactions = 'true' } = req.query as {
    url: string;
    pages?: string;
    depth?: string;
    device?: string;
    network?: string;
    ai?: string;
    interactions?: string;
  };

  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const engine = loadEngineConfig({ outputDir: OUTPUT_DIR, verbose: false });
  const reporter = new Reporter({ verbose: false, colour: false });

  reporter.onEvent((event) => {
    send('progress', { level: event.level, phase: event.phase, message: event.message });
  });

  const config: ResolvedAuditConfig = {
    url,
    maxPages: Math.min(Number(pages), 100),
    maxDepth: Math.min(Number(depth), 5),
    device: device as ResolvedAuditConfig['device'],
    network: network as ResolvedAuditConfig['network'],
    browser: 'CHROMIUM',
    aiAnalysis: ai === 'true',
    interactionTesting: interactions === 'true',
    lighthouse: false,
    checkExternalLinks: true,
    respectRobots: true,
    includeSubdomains: false,
    activeSecurityScan: false,
    authorizationAttestation: null,
    includePaths: [],
    excludePaths: [],
    label: null,
  };

  try {
    const result = await runAudit({ url, config, engine, reporter });

    // Send done immediately — don't block on HTML generation
    send('done', {
      auditId: result.auditId,
      scores: result.scores,
      stats: {
        pagesCrawled: result.stats.pagesCrawled,
        pagesFailed: result.stats.pagesFailed,
        requestsObserved: result.stats.requestsObserved,
        bytesTransferred: result.stats.bytesTransferred,
        consoleErrors: result.stats.consoleErrors,
        interactionsTested: result.stats.interactionsTested,
        linksChecked: result.stats.linksChecked,
        brokenLinks: result.stats.brokenLinks,
        findingsTotal: result.stats.findingsTotal,
        durationMs: result.stats.durationMs,
      },
      status: result.status,
      summary: result.summary,
      findings: result.findings.slice(0, 200),
      pages: result.pages,
    });

    // Generate HTML report in background
    const evidence = new EvidenceStore(OUTPUT_DIR);
    renderHtmlReport({ result, evidence })
      .then((html) => reports.set(result.auditId, html))
      .catch(() => {});
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

// ── GET /api/report/:auditId ─────────────────────────────────────────────────
app.get('/api/report/:auditId', async (req, res) => {
  const html = reports.get(req.params.auditId);
  if (!html) {
    // Try reading from disk (server restart case)
    try {
      const filePath = join(OUTPUT_DIR, req.params.auditId, 'report.html');
      const content = await readFile(filePath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.send(content);
    } catch {
      res.status(404).json({ error: 'Report not found' });
    }
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`webQA server running on http://localhost:${PORT}`);
});
