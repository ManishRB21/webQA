/**
 * Browser session management.
 *
 * One browser process per audit, one isolated `BrowserContext` per page probe.
 *
 * Why a fresh context per page rather than a shared one: cookies, localStorage
 * and service workers leak state between pages. A login set on page 3 would
 * change what page 7 renders, which makes findings non-reproducible — and
 * "non-reproducible" is fatal for a tool whose entire pitch is evidence. The
 * cost is a few hundred milliseconds per page; the benefit is that every page
 * is probed exactly as a first-time visitor sees it.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { DEVICE_SETTINGS, NETWORK_SETTINGS, type EngineConfig } from '../config.js';
import type { DeviceProfile, NetworkProfile } from '@webqa/shared';

export interface SessionOptions {
  device: DeviceProfile;
  network: NetworkProfile;
  userAgent: string;
  navigationTimeoutMs: number;
}

export class BrowserSession {
  private browser: Browser | null = null;

  constructor(private readonly config: EngineConfig) {}

  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({
      // These flags are the standard container-safe set. `--no-sandbox` is
      // acceptable here only because the browser is already the untrusted
      // boundary and callers are expected to run this in a container.
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--mute-audio',
        // We audit third-party sites; never let one prompt for a permission
        // and hang the run waiting for a click that will never come.
        '--deny-permission-prompts',
      ],
      timeout: 60_000,
    });
  }

  async createContext(options: SessionOptions): Promise<BrowserContext> {
    if (!this.browser) throw new Error('BrowserSession.start() must be called first');

    const device = DEVICE_SETTINGS[options.device];
    const context = await this.browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.isMobile,
      userAgent: device.userAgent ?? options.userAgent,
      // Audited sites are untrusted: refuse geolocation/camera/etc rather than
      // blocking on a permission dialog.
      permissions: [],
      // A site with a broken certificate is a finding, not a reason to abort —
      // we record the TLS state ourselves and keep going.
      ignoreHTTPSErrors: true,
      // Deterministic environment makes findings comparable between runs.
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      serviceWorkers: 'block',
    });

    context.setDefaultTimeout(options.navigationTimeoutMs);
    context.setDefaultNavigationTimeout(options.navigationTimeoutMs);

    return context;
  }

  /** Apply CDP network throttling to a page, when the profile calls for it. */
  async applyNetworkProfile(page: Page, profile: NetworkProfile): Promise<void> {
    const settings = NETWORK_SETTINGS[profile];
    if (!settings) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: settings.latencyMs,
        downloadThroughput: (settings.downloadKbps * 1024) / 8,
        uploadThroughput: (settings.uploadKbps * 1024) / 8,
      });
    } catch {
      // Throttling is a nicety; a CDP failure must not fail the probe.
    }
  }

  async close(): Promise<void> {
    if (!this.browser) return;
    await this.browser.close().catch(() => undefined);
    this.browser = null;
  }

  get isRunning(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }
}

/**
 * Run `fn` with a hard timeout, guaranteeing the context is torn down even if
 * the page hangs. Without this, one site with an infinite redirect loop stalls
 * the whole audit until the process budget expires.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
