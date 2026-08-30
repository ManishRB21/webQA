/**
 * Anthropic credential resolution.
 *
 * Most people running this already have Claude credentials — from the Claude
 * Code IDE extension, the CLI, or an `ant auth login` profile — and making them
 * paste a separate `ANTHROPIC_API_KEY` to use a tool on their own machine is
 * friction for no benefit. This module finds whatever is already there.
 *
 * The precedence order mirrors what the official SDKs and the `ant` CLI do, so
 * a user's mental model of "which credential am I on" holds here too:
 *
 *   1. ANTHROPIC_API_KEY        explicit env var wins, always
 *   2. ANTHROPIC_AUTH_TOKEN     explicit bearer token
 *   3. CLAUDE_CODE_OAUTH_TOKEN  set by some Claude Code contexts
 *   4. `ant auth print-credentials`  the documented way to hand a profile to a script
 *   5. ~/.claude/.credentials.json   what the Claude Code IDE extension writes
 *
 * The two credential KINDS are not interchangeable, and getting this wrong is
 * the classic silent-401:
 *
 *   API key    → `x-api-key: <key>`
 *   OAuth token → `Authorization: Bearer <token>` PLUS `anthropic-beta: oauth-2025-04-20`
 *
 * Sending an OAuth token as `x-api-key` fails authentication, and omitting the
 * beta header fails on /v1/messages specifically.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CredentialSource =
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_AUTH_TOKEN'
  | 'CLAUDE_CODE_OAUTH_TOKEN'
  | 'ant-cli'
  | 'claude-code-login'
  | 'none';

export type CredentialMode = 'api-key' | 'oauth';

export interface ResolvedCredential {
  mode: CredentialMode;
  /** Null only when `source` is `none`. Never logged. */
  value: string | null;
  source: CredentialSource;
  /** Epoch ms, when the source exposes one. */
  expiresAt: number | null;
  expired: boolean;
  /** Human-readable, safe to print — contains no secret material. */
  description: string;
}

const NONE: ResolvedCredential = {
  mode: 'api-key',
  value: null,
  source: 'none',
  expiresAt: null,
  expired: false,
  description: 'no Anthropic credentials found',
};

/** The beta flag required when authenticating with an OAuth bearer token. */
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/** Claude Code / `ant` OAuth access tokens carry this prefix. */
function looksLikeOauthToken(value: string): boolean {
  return value.startsWith('sk-ant-oat');
}

function fromEnv(): ResolvedCredential | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    // A user who exported an OAuth token into ANTHROPIC_API_KEY would otherwise
    // get an opaque 401; detect and route it correctly.
    if (looksLikeOauthToken(apiKey)) {
      return {
        mode: 'oauth',
        value: apiKey,
        source: 'ANTHROPIC_API_KEY',
        expiresAt: null,
        expired: false,
        description: 'ANTHROPIC_API_KEY (contains an OAuth token — using bearer auth)',
      };
    }
    return {
      mode: 'api-key',
      value: apiKey,
      source: 'ANTHROPIC_API_KEY',
      expiresAt: null,
      expired: false,
      description: 'ANTHROPIC_API_KEY environment variable',
    };
  }

  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (authToken) {
    return {
      mode: 'oauth',
      value: authToken,
      source: 'ANTHROPIC_AUTH_TOKEN',
      expiresAt: null,
      expired: false,
      description: 'ANTHROPIC_AUTH_TOKEN environment variable',
    };
  }

  const codeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (codeToken) {
    return {
      mode: 'oauth',
      value: codeToken,
      source: 'CLAUDE_CODE_OAUTH_TOKEN',
      expiresAt: null,
      expired: false,
      description: 'CLAUDE_CODE_OAUTH_TOKEN environment variable',
    };
  }

  return null;
}

/**
 * Ask the `ant` CLI for the active profile's access token.
 *
 * This is the documented mechanism for handing an OAuth profile to a script,
 * and it refreshes the token if needed — so it is preferred over reading a
 * credential file directly whenever the CLI is installed.
 *
 * `--access-token` is required: with no flag the command prints the whole
 * credentials JSON, which would land in an Authorization header as garbage.
 */
function fromAntCli(): ResolvedCredential | null {
  try {
    const token = execFileSync('ant', ['auth', 'print-credentials', '--access-token'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();

    if (!token || token.includes('{')) return null;

    return {
      mode: 'oauth',
      value: token,
      source: 'ant-cli',
      expiresAt: null,
      expired: false,
      description: 'active `ant auth login` profile',
    };
  } catch {
    // Not installed, not logged in, or the command failed — fall through.
    return null;
  }
}

interface ClaudeCodeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
}

/**
 * Read the credential file the Claude Code IDE extension and CLI maintain.
 *
 * This is a last resort rather than a first choice: unlike the `ant` CLI path
 * it cannot refresh an expired token, so we surface expiry clearly instead of
 * letting the user discover it as a 401 twenty minutes into an audit.
 */
function fromClaudeCodeLogin(): ResolvedCredential | null {
  const path = join(homedir(), '.claude', '.credentials.json');

  let parsed: ClaudeCodeCredentialsFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as ClaudeCodeCredentialsFile;
  } catch {
    return null;
  }

  const token = parsed.claudeAiOauth?.accessToken?.trim();
  if (!token) return null;

  const rawExpiry = parsed.claudeAiOauth?.expiresAt ?? null;
  // Tolerate seconds-vs-milliseconds; both appear in the wild.
  const expiresAt = rawExpiry === null ? null : rawExpiry > 1e12 ? rawExpiry : rawExpiry * 1000;
  const expired = expiresAt !== null && expiresAt <= Date.now();

  return {
    mode: 'oauth',
    value: token,
    source: 'claude-code-login',
    expiresAt,
    expired,
    description: expired
      ? 'Claude Code login (token EXPIRED — run `claude` or `/login` to refresh)'
      : 'Claude Code login (~/.claude/.credentials.json)',
  };
}

/**
 * Resolve the credential to use, in precedence order.
 * Never throws — an unresolvable credential is a normal state that degrades the
 * audit to deterministic-only analysis.
 */
export function resolveAnthropicCredential(): ResolvedCredential {
  return fromEnv() ?? fromAntCli() ?? fromClaudeCodeLogin() ?? NONE;
}

/** A short line describing the credential, safe for logs and the report. */
export function describeCredential(credential: ResolvedCredential): string {
  if (credential.source === 'none') return 'none';
  const expiry =
    credential.expiresAt !== null
      ? ` · ${credential.expired ? 'expired' : `valid for ${formatRemaining(credential.expiresAt - Date.now())}`}`
      : '';
  return `${credential.description} [${credential.mode}]${expiry}`;
}

function formatRemaining(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
