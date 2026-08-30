import { useState } from 'react';
import type { AuditDonePayload, Finding } from '../App';

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: 'bg-red-500/20 text-red-400 border-red-500/30',
  HIGH: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  MEDIUM: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  LOW: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  INFO: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

const SCORE_COLOR = (score: number) =>
  score >= 80 ? 'text-green-400' : score >= 60 ? 'text-yellow-400' : 'text-red-400';

const CATEGORY_ICONS: Record<string, string> = {
  FUNCTIONAL: '⚙',
  PERFORMANCE: '⚡',
  ACCESSIBILITY: '♿',
  SEO: '🔍',
  SECURITY: '🔒',
  UI_UX: '🎨',
};

interface Props {
  result: AuditDonePayload;
  url: string;
  onReset: () => void;
  apiBase: string;
}

export default function AuditResults({ result, url, onReset, apiBase }: Props) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);

  const categories = [...new Set(result.findings.map((f) => f.category))].sort();
  const filtered = activeCategory
    ? result.findings.filter((f) => f.category === activeCategory)
    : result.findings;

  const scoreEntries = Object.entries(result.scores).filter(
    ([k, v]) => k !== 'overall' && typeof v === 'number'
  );

  const handlePrint = () => window.print();

  const handleDownloadReport = () => {
    window.open(`${apiBase}/api/report/${result.auditId}`, '_blank');
  };

  return (
    <div className="flex flex-col gap-6 sm:gap-10 px-1">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 no-print">
        <div className="min-w-0">
          <h2 className="text-xl sm:text-3xl font-bold break-all">{url}</h2>
          <p className="text-gray-500 text-sm sm:text-lg mt-1 sm:mt-2">
            {result.stats.pagesCrawled as number} pages · {result.stats.findingsTotal as number} findings ·{' '}
            <span className={result.status === 'COMPLETED' ? 'text-green-400' : 'text-yellow-400'}>
              {result.status}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            onClick={handleDownloadReport}
            className="flex-1 sm:flex-none px-4 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm transition-colors border border-gray-700"
          >
            Full Report
          </button>
          <button
            onClick={handlePrint}
            className="flex-1 sm:flex-none px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm font-semibold transition-colors"
          >
            Download PDF
          </button>
          <button
            onClick={onReset}
            className="flex-1 sm:flex-none px-4 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm transition-colors border border-gray-700"
          >
            New Audit
          </button>
        </div>
      </div>

      {/* Overall score */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 sm:p-8 flex flex-col sm:flex-row items-center gap-6 sm:gap-12">
        <div className="text-center">
          <div className={`text-7xl sm:text-8xl font-bold ${SCORE_COLOR(result.scores.overall)}`}>
            {result.scores.overall}
          </div>
          <div className="text-gray-500 text-base sm:text-lg mt-1">Overall</div>
        </div>
        <div className="flex-1 w-full grid grid-cols-3 gap-3 sm:gap-6">
          {scoreEntries.map(([key, val]) => (
            <div key={key} className="text-center bg-gray-800/50 rounded-xl p-3 sm:p-4">
              <div className={`text-2xl sm:text-4xl font-bold ${SCORE_COLOR(val as number)}`}>{val as number}</div>
              <div className="text-gray-400 text-xs sm:text-sm mt-1 capitalize">{key.toLowerCase()}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Summary */}
      {result.summary?.headline && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 sm:p-7">
          <p className="font-semibold text-gray-100 text-lg sm:text-xl mb-2 sm:mb-3">{result.summary.headline}</p>
          <p className="text-gray-400 text-sm sm:text-base leading-relaxed">{result.summary.body}</p>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {[
          { label: 'Pages crawled', value: result.stats.pagesCrawled as number },
          { label: 'Requests', value: result.stats.requestsObserved as number },
          { label: 'Broken links', value: result.stats.brokenLinks as number },
          { label: 'Console errors', value: result.stats.consoleErrors as number },
        ].map(({ label, value }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-2xl p-4 sm:p-6 text-center">
            <div className="text-3xl sm:text-4xl font-bold">{value}</div>
            <div className="text-gray-500 text-xs sm:text-sm mt-1 sm:mt-2">{label}</div>
          </div>
        ))}
      </div>

      {/* Findings */}
      <div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 sm:mb-6 gap-3 no-print">
          <h3 className="font-bold text-xl sm:text-2xl">Findings</h3>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setActiveCategory(null)}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium transition-colors ${
                activeCategory === null ? 'bg-indigo-600' : 'bg-gray-800 hover:bg-gray-700'
              }`}
            >
              All ({result.findings.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat === activeCategory ? null : cat)}
                className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium transition-colors ${
                  activeCategory === cat ? 'bg-indigo-600' : 'bg-gray-800 hover:bg-gray-700'
                }`}
              >
                {CATEGORY_ICONS[cat] ?? ''} {cat.toLowerCase()} (
                {result.findings.filter((f) => f.category === cat).length})
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:gap-3">
          {filtered.length === 0 && (
            <p className="text-gray-500 text-center py-10 text-base sm:text-lg">No findings in this category.</p>
          )}
          {filtered.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              expanded={expandedFinding === finding.id}
              onToggle={() => setExpandedFinding(expandedFinding === finding.id ? null : finding.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FindingCard({ finding, expanded, onToggle }: { finding: Finding; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-start sm:items-center gap-3 sm:gap-4 px-4 sm:px-6 py-4 sm:py-5 text-left hover:bg-gray-800/50 transition-colors"
      >
        <span className={`text-xs px-2.5 py-1 rounded-lg border font-semibold whitespace-nowrap shrink-0 ${SEVERITY_COLOR[finding.severity]}`}>
          {finding.severity}
        </span>
        <span className="flex-1 text-sm sm:text-base font-medium">{finding.title}</span>
        <div className="flex flex-col sm:flex-row items-end sm:items-center gap-1 sm:gap-3 shrink-0">
          {finding.occurrences > 1 && (
            <span className="text-xs text-gray-500">{finding.occurrences}×</span>
          )}
          <span className={`text-xs sm:text-sm ${finding.confidence === 'CONFIRMED' ? 'text-green-500' : 'text-yellow-500'}`}>
            {finding.confidence}
          </span>
          <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-6 pb-5 sm:pb-6 border-t border-gray-800 pt-4 sm:pt-5 flex flex-col gap-3 sm:gap-4">
          <p className="text-gray-300 text-sm sm:text-base leading-relaxed">{finding.description}</p>
          {finding.recommendation && (
            <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 sm:p-5">
              <p className="text-xs sm:text-sm text-indigo-300 font-semibold mb-1.5 sm:mb-2">Recommendation</p>
              <p className="text-sm sm:text-base text-gray-300">{finding.recommendation}</p>
            </div>
          )}
          {finding.urls?.length > 0 && (
            <div>
              <p className="text-xs sm:text-sm text-gray-500 mb-1.5">Affected URLs</p>
              <div className="flex flex-col gap-1">
                {finding.urls.slice(0, 5).map((u) => (
                  <span key={u} className="text-xs sm:text-sm text-gray-400 font-mono break-all">{u}</span>
                ))}
                {finding.urls.length > 5 && (
                  <span className="text-xs sm:text-sm text-gray-600">+{finding.urls.length - 5} more</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
