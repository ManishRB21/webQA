/**
 * LLM provider abstraction.
 *
 * The engine depends on this interface, never on a vendor SDK. Two reasons:
 * a user should be able to run against whatever model they have access to, and
 * — more importantly — the whole pipeline must work with `provider: none`. AI
 * is an enrichment layer over deterministic findings, never a dependency of
 * them. If the API key is missing or the call fails, the audit still produces
 * a complete report; it just has less narrative in it.
 */

export interface StructuredRequest<T> {
  /** Stable across calls so it can be prompt-cached. */
  system: string;
  /** The evidence payload. */
  user: string;
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  /** Identifies the call in logs and the AI audit trail. */
  purpose: string;
  maxTokens?: number;
}

export interface StructuredResponse<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
  model: string;
  provider: string;
  /** Set when the model declined the request rather than failing. */
  refusal: { category: string | null; explanation: string | null } | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Ask for a JSON object matching `schema`. */
  complete<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}

/**
 * The no-op provider. Selected when AI is disabled or no key is configured.
 * It returns a clean failure rather than throwing, so callers need no special
 * casing — the enrichment step simply produces nothing.
 */
export class NullProvider implements LlmProvider {
  readonly name = 'none';
  readonly model = 'none';

  async complete<T>(): Promise<StructuredResponse<T>> {
    return {
      ok: false,
      data: null,
      error: 'AI analysis is disabled',
      usage: null,
      latencyMs: 0,
      model: this.model,
      provider: this.name,
      refusal: null,
    };
  }
}

/**
 * Extract the first JSON object from a text response.
 *
 * Structured outputs make this unnecessary in the happy path, but a provider
 * without that feature — or a model that wraps its JSON in a code fence — would
 * otherwise cost us the entire enrichment batch.
 */
export function extractJson<T>(text: string): T | null {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch { /* fall through */ }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch { /* fall through */ }
  }

  // Last resort: locate the outermost balanced object.
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, index + 1)) as T;
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}
