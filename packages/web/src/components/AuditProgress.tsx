import { useEffect, useRef } from 'react';
import type { LogEntry } from '../App';

const PHASE_LABELS: Record<string, string> = {
  PREFLIGHT: 'Preflight',
  DISCOVERY: 'Discovery',
  CRAWL: 'Crawling',
  LINK_CHECK: 'Link Check',
  ANALYSIS: 'Analysis',
  AI_ANALYSIS: 'AI Analysis',
  REPORT: 'Generating Report',
};

const PHASES = Object.keys(PHASE_LABELS);

const levelColor: Record<string, string> = {
  info: 'text-gray-400',
  success: 'text-green-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
  debug: 'text-gray-600',
};

interface Props {
  logs: LogEntry[];
  url: string;
}

export default function AuditProgress({ logs, url }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const currentPhase = [...logs].reverse().find((l) => l.phase)?.phase ?? null;
  const currentPhaseIndex = currentPhase ? PHASES.indexOf(currentPhase) : -1;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-6 px-2">
      <div className="text-center">
        <div className="inline-flex items-center gap-3 text-indigo-400 mb-2">
          <span className="animate-spin text-2xl sm:text-3xl">⟳</span>
          <span className="text-lg sm:text-2xl font-semibold break-all">{url}</span>
        </div>
      </div>

      {/* Phase progress bar */}
      <div className="flex gap-1.5">
        {PHASES.map((phase, i) => (
          <div
            key={phase}
            className={`flex-1 h-2 sm:h-2.5 rounded-full transition-colors duration-500 ${
              i < currentPhaseIndex
                ? 'bg-indigo-500'
                : i === currentPhaseIndex
                ? 'bg-indigo-400 animate-pulse'
                : 'bg-gray-800'
            }`}
            title={PHASE_LABELS[phase]}
          />
        ))}
      </div>

      {currentPhase && (
        <p className="text-center text-base sm:text-lg text-indigo-300 font-medium">
          {PHASE_LABELS[currentPhase] ?? currentPhase}
        </p>
      )}

      {/* Log stream */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 sm:p-6 h-72 sm:h-[28rem] overflow-y-auto font-mono text-xs sm:text-sm">
        {logs.map((log, i) => (
          <div key={i} className={`${levelColor[log.level] ?? 'text-gray-400'} leading-6 sm:leading-7`}>
            {log.level === 'success' ? '✓' : log.level === 'warn' ? '!' : log.level === 'error' ? '✗' : '·'}{' '}
            {log.message}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
