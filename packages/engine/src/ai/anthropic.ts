/**
 * Anthropic provider.
 *
 * Notes on the request shape, since several of these are easy to get wrong:
 *
 *   - `output_config.format` with a JSON Schema constrains the response, which
 *     removes the whole class of "the model wrapped its JSON in prose" bugs.
 *   - No `temperature` / `top_p`: current models reject them outright.
 *   - No `budget_tokens`: replaced by adaptive thinking plus `effort`.
 *   - The system prompt is marked cacheable. It is identical across every
 *     enrichment call in an audit, so after the first request the rest read it
 *     from cache at a fraction of the cost.
 *   - `stop_reason: "refusal"` is a successful HTTP 200, not an exception.
 *     Code that reads `content[0]` without checking will throw on it.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, StructuredRequest, StructuredResponse } from './provider.js';
import { extractJson } from './provider.js';
import { OAUTH_BETA_HEADER, type ResolvedCredential } from './credentials.js';

export interface AnthropicProviderOptions {
  /** Resolved by `resolveAnthropicCredential()` — API key or OAuth token. */
  credential: ResolvedCredential;
  model: string;
  /** Thinking depth / token spend. `medium` is the right default for this task. */
  effort?: 'low' | 'medium' | 'high';
  maxRetries?: number;
  timeoutMs?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: 'low' | 'medium' | 'high';
  private readonly credential: ResolvedCredential;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.effort = options.effort ?? 'medium';
    this.credential = options.credential;

    const shared = {
      maxRetries: options.maxRetries ?? 2,
      // Enrichment batches are small; a long timeout only delays a failure.
      timeout: options.timeoutMs ?? 120_000,
    };

    // The two credential kinds travel in different headers. An OAuth token sent
    // as `x-api-key` authenticates as nobody, and on /v1/messages it also needs
    // the oauth beta flag — omit either and you get an opaque 401.
    this.client =
      options.credential.mode === 'oauth'
        ? new Anthropic({
            ...shared,
            apiKey: null,
            authToken: options.credential.value ?? undefined,
            defaultHeaders: { 'anthropic-beta': OAUTH_BETA_HEADER },
          })
        : new Anthropic({ ...shared, apiKey: options.credential.value ?? undefined });
  }

  async complete<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const startedAt = Date.now();

    const base = {
      model: this.model,
      max_tokens: request.maxTokens ?? 8000,
      system: [
        {
          type: 'text' as const,
          text: request.system,
          // The system prompt is identical for every finding batch in a run.
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      messages: [{ role: 'user' as const, content: request.user }],
      output_config: {
        effort: this.effort,
        format: { type: 'json_schema', schema: request.schema },
      },
    };

    try {
      // SDK typings lag the structured-output parameter shape; the wire format
      // is correct and documented.
      const response = (await this.client.messages.create(
        base as unknown as Anthropic.MessageCreateParamsNonStreaming,
      )) as Anthropic.Message;

      const latencyMs = Date.now() - startedAt;

      // A refusal is an HTTP 200. Check before touching content.
      if (response.stop_reason === 'refusal') {
        const details = (response as unknown as {
          stop_details?: { category?: string | null; explanation?: string | null };
        }).stop_details;
        return {
          ok: false,
          data: null,
          error: 'The model declined to analyse this batch',
          usage: {
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
          },
          latencyMs,
          model: this.model,
          provider: this.name,
          refusal: {
            category: details?.category ?? null,
            explanation: details?.explanation ?? null,
          },
        };
      }

      if (response.stop_reason === 'max_tokens') {
        return {
          ok: false,
          data: null,
          error: 'Response was truncated at max_tokens — batch too large',
          usage: {
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
          },
          latencyMs,
          model: this.model,
          provider: this.name,
          refusal: null,
        };
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const data = extractJson<T>(text);

      return {
        ok: data !== null,
        data,
        error: data === null ? 'Model response was not valid JSON' : null,
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        },
        latencyMs,
        model: this.model,
        provider: this.name,
        refusal: null,
      };
    } catch (error) {
      return {
        ok: false,
        data: null,
        error: this.describeError(error),
        usage: null,
        latencyMs: Date.now() - startedAt,
        model: this.model,
        provider: this.name,
        refusal: null,
      };
    }
  }

  /**
   * Turn an SDK error into something actionable.
   *
   * Auth failures name the credential that was actually used — "check your API
   * key" is useless advice when the tool silently picked up a stale IDE login.
   */
  private describeError(error: unknown): string {
    if (error instanceof Anthropic.AuthenticationError) {
      const hint =
        this.credential.source === 'claude-code-login'
          ? 'the Claude Code login token was rejected (it may have expired) — reopen Claude Code or run `claude` to refresh it, or set ANTHROPIC_API_KEY'
          : this.credential.source === 'ant-cli'
            ? 'the `ant` profile token was rejected — run `ant auth login`, or set ANTHROPIC_API_KEY'
            : `credential from ${this.credential.source} was rejected`;
      return `Authentication failed: ${hint}`;
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return `Access denied for model "${this.model}" using ${this.credential.source} — the credential may not be entitled to this model`;
    }
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = error.headers?.get?.('retry-after');
      const when = retryAfter ? ` Retry after ${retryAfter}s.` : '';
      // A subscription token shares one quota with interactive Claude usage, so
      // "rate limited" here usually means the plan's budget is spent, not that
      // this tool is being too aggressive. Say so — the obvious reading is
      // wrong and sends people optimising the wrong thing.
      return this.credential.mode === 'oauth'
        ? `Rate limited: this Claude subscription's usage quota is currently exhausted (it is shared with interactive Claude/Claude Code usage).${when} Findings are unaffected — only AI enrichment was skipped.`
        : `Rate limited by the Anthropic API.${when}`;
    }
    return describeError(error);
  }

  /** True when the failure is account-wide, so retrying other batches is futile. */
  static isTerminalFailure(error: string | null): boolean {
    if (!error) return false;
    return /rate limited|authentication failed|access denied/i.test(error);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    // Typed subclasses carry the distinction that matters for retry decisions.
    if (error instanceof Anthropic.AuthenticationError) {
      return 'Authentication failed';
    }
    if (error instanceof Anthropic.RateLimitError) {
      return 'Rate limited by the Anthropic API';
    }
    if (error instanceof Anthropic.NotFoundError) {
      return `Model "${(error as { model?: string }).model ?? 'unknown'}" not found — check AI_MODEL`;
    }
    return `Anthropic API error ${error.status}: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API — check network connectivity';
  }
  return error instanceof Error ? error.message : String(error);
}
