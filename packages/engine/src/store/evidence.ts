/**
 * Evidence and result storage — plain files, no database.
 *
 * Layout under the output directory:
 *
 *   <outputDir>/
 *     <auditId>/
 *       audit.json          the full result bundle (config, observations, findings)
 *       report.html         the shareable, self-contained report
 *       screenshots/<hash>.jpg
 *
 * Screenshots are also base64-inlined into the HTML report so a single file can
 * be emailed or dropped in a ticket and still render. The files on disk remain
 * the canonical copy for tooling that wants them separately.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export type ScreenshotKind = 'viewport' | 'fullpage' | 'evidence';

export interface StoredScreenshot {
  key: string;
  pageUrl: string;
  kind: ScreenshotKind;
  sizeBytes: number;
  capturedAt: string;
}

export class EvidenceStore {
  private readonly screenshots = new Map<string, StoredScreenshot>();

  constructor(private readonly rootDir: string) {}

  private auditDir(auditId: string): string {
    // Audit ids are generated internally, but validate anyway: this value ends
    // up in a filesystem path.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(auditId)) {
      throw new Error(`Refusing to use unsafe audit id as a path segment: "${auditId}"`);
    }
    return join(resolve(this.rootDir), auditId);
  }

  async init(auditId: string): Promise<void> {
    await mkdir(join(this.auditDir(auditId), 'screenshots'), { recursive: true });
  }

  /**
   * Persist a screenshot and return its storage key.
   * The key is derived from a hash of the discriminator, so re-probing the same
   * page overwrites rather than accumulating duplicates.
   */
  async putScreenshot(
    auditId: string,
    discriminator: string,
    kind: ScreenshotKind,
    body: Buffer,
  ): Promise<string> {
    const hash = createHash('sha1').update(`${kind}:${discriminator}`).digest('hex').slice(0, 16);
    const key = `screenshots/${hash}.jpg`;
    const path = this.resolveKey(auditId, key);
    await mkdir(join(this.auditDir(auditId), 'screenshots'), { recursive: true });
    await writeFile(path, body);

    this.screenshots.set(key, {
      key,
      pageUrl: discriminator,
      kind,
      sizeBytes: body.byteLength,
      capturedAt: new Date().toISOString(),
    });

    return key;
  }

  /** Read a stored artifact back, e.g. to inline it into the HTML report. */
  async read(auditId: string, key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolveKey(auditId, key));
    } catch {
      return null;
    }
  }

  async readAsDataUri(auditId: string, key: string): Promise<string | null> {
    const bytes = await this.read(auditId, key);
    if (!bytes) return null;
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  }

  listScreenshots(): StoredScreenshot[] {
    return [...this.screenshots.values()];
  }

  async writeJson(auditId: string, filename: string, value: unknown): Promise<string> {
    const path = this.resolveKey(auditId, filename);
    await mkdir(this.auditDir(auditId), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
    return path;
  }

  async writeText(auditId: string, filename: string, contents: string): Promise<string> {
    const path = this.resolveKey(auditId, filename);
    await mkdir(this.auditDir(auditId), { recursive: true });
    await writeFile(path, contents, 'utf8');
    return path;
  }

  async readJson<T>(auditId: string, filename: string): Promise<T | null> {
    try {
      const raw = await readFile(this.resolveKey(auditId, filename), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Enumerate previous audits — the basis of regression comparison. */
  async listAudits(): Promise<string[]> {
    const root = resolve(this.rootDir);
    if (!existsSync(root)) return [];
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name))
      .map((entry) => entry.name);
  }

  pathFor(auditId: string, key: string): string {
    return this.resolveKey(auditId, key);
  }

  /** Reject keys that would escape the audit directory. */
  private resolveKey(auditId: string, key: string): string {
    if (!key || key.includes('\0') || key.length > 256) {
      throw new Error('Invalid storage key');
    }
    const base = this.auditDir(auditId);
    const full = resolve(join(base, key));
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`Invalid storage key: escapes the audit directory ("${key}")`);
    }
    return full;
  }
}
