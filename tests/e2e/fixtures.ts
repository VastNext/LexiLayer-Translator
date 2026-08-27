import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';

import { startMockServer, type MockServer } from './mock-server';

interface ErrorLog {
  console: string[];
  messages: string[];
  page: string[];
  worker: string[];
}

interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  server: MockServer;
  errors: ErrorLog;
  openExtensionPage(path: 'popup.html' | 'options.html'): Promise<Page>;
}

export const test = base.extend<ExtensionFixtures>({
  server: async ({}, use) => {
    const server = await startMockServer();
    await use(server);
    server.releaseDelay();
    await server.close();
  },
  context: async ({ server }, use) => {
    const userDataDir = await mkdtemp(resolve(tmpdir(), 'vast-e2e-'));
    const extensionPath = resolve(import.meta.dirname, '../../dist');
    const proxy = process.env.VAST_E2E_PROXY;
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
        ...(proxy ? [`--proxy-server=${proxy}`] : []),
      ],
    });
    await use(context);
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
    void server;
  },
  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    const extensionId = new URL(serviceWorker.url()).host;
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    await use(extensionId);
  },
  errors: async ({ context, serviceWorker }, use) => {
    const errors: ErrorLog = { console: [], messages: [], page: [], worker: [] };
    const watch = (page: Page) => {
      page.on('console', (message) => {
        errors.messages.push(`${message.type()}: ${message.text()}`);
        if (message.type() === 'error') errors.console.push(`${page.url()}: ${message.text()}`);
      });
      page.on('pageerror', (error) => errors.page.push(`${page.url()}: ${error.message}`));
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    serviceWorker.on('console', (message) => {
      errors.messages.push(`worker ${message.type()}: ${message.text()}`);
      if (message.type() === 'error') errors.worker.push(message.text());
    });
    await use(errors);
    expect(errors.console, `控制台错误:\n${errors.console.join('\n')}`).toHaveLength(0);
    expect(errors.page, `页面异常:\n${errors.page.join('\n')}`).toHaveLength(0);
    expect(errors.worker, `Service Worker 错误:\n${errors.worker.join('\n')}`).toHaveLength(0);
  },
  openExtensionPage: async ({ context, extensionId, errors }, use) => {
    await use(async (path) => {
      void errors;
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${path}`);
      return page;
    });
  },
});

export { expect } from '@playwright/test';
