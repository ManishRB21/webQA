/**
 * Progress reporting.
 *
 * The engine emits a structured event stream. The CLI renders it as a live
 * console log; a future HTTP server can forward the same events over SSE
 * without the engine knowing the difference.
 *
 * Everything routed through here is redacted first — audit logs describe
 * third-party sites and must never carry a bearer token into a terminal
 * scrollback or a CI log.
 */

import { redactText, redactUrl, type AuditPhase } from '@webqa/shared';

export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

export interface ProgressEvent {
  at: string;
  level: LogLevel;
  phase: AuditPhase | null;
  message: string;
  data?: Record<string, unknown>;
}

export type ProgressListener = (event: ProgressEvent) => void;

const LEVEL_STYLES: Record<LogLevel, { colour: string; symbol: string }> = {
  info: { colour: '\x1b[36m', symbol: '·' },
  success: { colour: '\x1b[32m', symbol: '✓' },
  warn: { colour: '\x1b[33m', symbol: '!' },
  error: { colour: '\x1b[31m', symbol: '✗' },
  debug: { colour: '\x1b[90m', symbol: '·' },
};

const RESET = '\x1b[0m';
const DIM = '\x1b[90m';

export class Reporter {
  private readonly listeners = new Set<ProgressListener>();
  private phase: AuditPhase | null = null;
  private readonly events: ProgressEvent[] = [];

  constructor(
    private readonly options: { verbose: boolean; colour: boolean } = { verbose: true, colour: true },
  ) {}

  onEvent(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPhase(phase: AuditPhase, message: string): void {
    this.phase = phase;
    this.emit('info', message, undefined, true);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.emit('info', message, data);
  }

  success(message: string, data?: Record<string, unknown>): void {
    this.emit('success', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.emit('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.emit('error', message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (!this.options.verbose) return;
    this.emit('debug', message, data);
  }

  /** All events emitted so far — embedded into the report's activity log. */
  history(): ProgressEvent[] {
    return [...this.events];
  }

  private emit(level: LogLevel, rawMessage: string, data?: Record<string, unknown>, isPhase = false): void {
    const message = redactText(rawMessage);
    const event: ProgressEvent = {
      at: new Date().toISOString(),
      level,
      phase: this.phase,
      message,
      ...(data ? { data: redactData(data) } : {}),
    };

    this.events.push(event);
    // Keep memory bounded on very large crawls.
    if (this.events.length > 5000) this.events.splice(0, 1000);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must never take down an audit.
      }
    }

    this.write(event, isPhase);
  }

  private write(event: ProgressEvent, isPhase: boolean): void {
    if (event.level === 'debug' && !this.options.verbose) return;

    const time = event.at.slice(11, 19);
    const style = LEVEL_STYLES[event.level];

    if (!this.options.colour) {
      process.stderr.write(`[${time}] ${style.symbol} ${event.message}\n`);
      return;
    }

    const prefix = isPhase ? `\n${'\x1b[1m'}` : '';
    const suffix = isPhase ? RESET : '';
    process.stderr.write(
      `${DIM}[${time}]${RESET} ${style.colour}${style.symbol}${RESET} ${prefix}${event.message}${suffix}\n`,
    );
  }
}

/** Redact URLs and token-shaped strings inside structured log data. */
function redactData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      out[key] = /^https?:\/\//i.test(value) ? redactUrl(value) : redactText(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A reporter that swallows everything — used in tests. */
export function silentReporter(): Reporter {
  return new Reporter({ verbose: false, colour: false });
}
