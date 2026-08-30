import { useState } from 'react';
import AuditForm from './components/AuditForm';
import AuditProgress from './components/AuditProgress';
import AuditResults from './components/AuditResults';

export type AuditState =
  | { phase: 'idle' }
  | { phase: 'running'; logs: LogEntry[]; url: string }
  | { phase: 'done'; result: AuditDonePayload; url: string }
  | { phase: 'error'; message: string };

export interface LogEntry {
  level: string;
  phase: string | null;
  message: string;
}

export interface AuditDonePayload {
  auditId: string;
  scores: Record<string, number>;
  stats: Record<string, number | Record<string, number>>;
  status: string;
  summary: { headline: string; body: string };
  findings: Finding[];
  pages: PageSummary[];
}

export interface Finding {
  id: string;
  ruleId: string;
  title: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  category: string;
  confidence: 'CONFIRMED' | 'POSSIBLE';
  description: string;
  recommendation: string;
  occurrences: number;
  urls: string[];
}

export interface PageSummary {
  url: string;
  httpStatus: number | null;
  title: string | null;
  healthScore: number;
  findingCount: number;
  loadTimeMs: number | null;
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export default function App() {
  const [state, setState] = useState<AuditState>({ phase: 'idle' });

  const startAudit = (params: {
    url: string;
    pages: number;
    depth: number;
    device: string;
    network: string;
    ai: boolean;
    interactions: boolean;
  }) => {
    const logs: LogEntry[] = [];
    setState({ phase: 'running', logs: [], url: params.url });

    const es = new EventSource(`${API_BASE}/api/audit-sse?` + new URLSearchParams({
      url: params.url,
      pages: String(params.pages),
      depth: String(params.depth),
      device: params.device,
      network: params.network,
      ai: String(params.ai),
      interactions: String(params.interactions),
    }));

    es.addEventListener('progress', (e) => {
      const entry: LogEntry = JSON.parse(e.data);
      logs.push(entry);
      setState({ phase: 'running', logs: [...logs], url: params.url });
    });

    es.addEventListener('done', (e) => {
      es.close();
      const result: AuditDonePayload = JSON.parse(e.data);
      setState({ phase: 'done', result, url: params.url });
    });

    es.addEventListener('error', (e) => {
      es.close();
      const data = (e as MessageEvent).data;
      setState({ phase: 'error', message: data ? JSON.parse(data).message : 'Connection lost' });
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      es.close();
      setState({ phase: 'error', message: 'Lost connection to server' });
    };
  };

  const reset = () => setState({ phase: 'idle' });

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-gray-800 px-4 sm:px-8 py-4 sm:py-5 flex items-center gap-3 sm:gap-4 no-print">
        <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-indigo-500 flex items-center justify-center font-bold text-white text-base sm:text-lg">Q</div>
        <span className="font-bold text-xl sm:text-2xl tracking-tight">webQA</span>
        <span className="text-gray-500 text-sm sm:text-base ml-1 hidden sm:inline">Automated Website Auditor</span>
      </header>

      <main className="flex-1 px-3 sm:px-6 py-6 sm:py-10 max-w-7xl mx-auto w-full">
        {state.phase === 'idle' && <AuditForm onSubmit={startAudit} />}
        {state.phase === 'running' && <AuditProgress logs={state.logs} url={state.url} />}
        {state.phase === 'done' && (
          <AuditResults result={state.result} url={state.url} onReset={reset} apiBase={API_BASE} />
        )}
        {state.phase === 'error' && (
          <div className="text-center py-32">
            <p className="text-red-400 text-2xl mb-6">{state.message}</p>
            <button onClick={reset} className="px-8 py-3 text-lg bg-indigo-600 rounded-xl hover:bg-indigo-500 transition-colors">
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
