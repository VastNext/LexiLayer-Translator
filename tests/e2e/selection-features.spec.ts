import type { BrowserContext, Locator, Page, Worker } from '@playwright/test';

import { expect, test } from './fixtures';
import type { MockServer } from './mock-server';

// 划词浮层（朗读 / 重试 / 复制 / 加入生词）的 E2E 冒烟测试。
//
// 面板位于内容脚本创建的 closed Shadow DOM 内：主世界无法访问（element.shadowRoot 为
// null，Playwright 定位器也无法穿透），只有扩展自己的隔离世界持有引用。因此测试在
// 首次划词前通过 Service Worker 调 chrome.scripting.executeScript（默认即内容脚本所在的
// ISOLATED 世界）包装 Element.prototype.attachShadow，把 closed root 捕获到宿主元素上，
// 之后全部断言经同一隔离世界读取。不修改 src/，不影响生产行为。
//
// 注意：Service Worker evaluate 回调体内引用的一切必须是回调内定义或经参数传入，
// 模块作用域的常量/函数不会被序列化进 Worker。

const API_KEY = 'e2e-secret-key-not-for-dom';
// 与既有用例相同的鼠标手势从段落两端各留 8px，实际选中文本可能裁掉首字符，
// 因此存储断言只匹配句子的稳定中段。
const SELECTION_TEXT_PART = 'this sentence with a real mouse gesture';
// chrome.tabs.query 的 url 过滤使用 match pattern（不支持端口）；mock 服务器固定监听 127.0.0.1。
const FIXTURE_TAB_PATTERN = 'http://127.0.0.1/*';
const PRESS_WAIT_MS = 8_000;

interface PanelActionSnapshot {
  action: string;
  label: string;
  pressed: string | null;
  disabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PanelSnapshot {
  actions: PanelActionSnapshot[];
  toast: { text: string; hidden: boolean };
  result: string;
}

interface PressedProbe {
  pressed: string | null;
  toastText: string;
  toastHidden: boolean;
}

type CapturedHost = HTMLElement & { __vastCapturedShadow?: ShadowRoot };

async function configureCustomAiEngine(
  openExtensionPage: (path: 'popup.html' | 'options.html') => Promise<Page>,
  server: MockServer,
): Promise<void> {
  const options = await openExtensionPage('options.html');
  // 与既有用例一致：等待配置真正加载完成（按钮 disabled={!loaded}）再操作。
  await expect(options.getByRole('button', { name: '新增自定义 AI' })).toBeEnabled();
  await options.getByRole('button', { name: '新增自定义 AI' }).click();
  const card = options.getByRole('group').last();
  await expect(card.getByLabel('Base URL')).toBeEnabled();
  await card.getByLabel('名称').fill('E2E 划词能力 AI');
  await card.getByLabel('Base URL').fill(server.baseUrl);
  await card.getByLabel('API Key', { exact: true }).fill(API_KEY);
  await card.getByLabel('模型').fill('e2e-model');
  await card.getByRole('button', { name: '保存实例' }).click();
  await expect(options.getByRole('status')).toHaveText('实例已保存');
  await options.getByRole('group', { name: 'E2E 划词能力 AI' }).getByRole('button', { name: '设为默认' }).click();
  await expect(options.getByRole('status')).toHaveText('默认引擎已更新');
  await options.close();
}

async function openFixturePage(context: BrowserContext, server: MockServer, serviceWorker: Worker): Promise<Page> {
  const page = await context.newPage();
  await page.goto(server.fixtureUrl);
  await expect(page.locator('main')).toBeVisible();
  // 在首次划词前安装 closed shadow 捕获（见文件头说明）。
  await serviceWorker.evaluate(async ({ pattern }) => {
    const [tab] = await chrome.tabs.query({ url: pattern });
    if (tab?.id === undefined) throw new Error('找不到划词 fixture 标签页');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const proto = Element.prototype as unknown as {
          attachShadow: (this: Element, init: ShadowRootInit) => ShadowRoot;
          __vastShadowCaptureInstalled?: boolean;
        };
        if (proto.__vastShadowCaptureInstalled) return;
        proto.__vastShadowCaptureInstalled = true;
        const original = proto.attachShadow;
        proto.attachShadow = function attachShadowWithCapture(this: Element, init: ShadowRootInit): ShadowRoot {
          const root = original.call(this, init);
          if (init.mode === 'closed') (this as CapturedHost).__vastCapturedShadow = root;
          return root;
        };
      },
    });
  }, { pattern: FIXTURE_TAB_PATTERN });
  return page;
}

/** 与既有划词用例相同的真实鼠标手势触发方式。 */
async function selectSentence(page: Page): Promise<void> {
  // 点击面板按钮不会清除页面选区：若带着旧选区在原文上按下鼠标，Chromium 会发起
  // 原生文本拖拽并吞掉 mouseup，新浮层将无法创建。先收起选区再执行手势。
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  const paragraph = page.locator('#selection');
  const box = await paragraph.boundingBox();
  if (!box) throw new Error('划词段落不可见');
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
}

/** 点击浮层 trigger 打开面板，返回宿主元素。 */
async function openSelectionPanel(page: Page): Promise<Locator> {
  const host = page.locator('[data-vast-selection-host]');
  await expect(host).toBeVisible();
  await expect(host).toHaveAttribute('data-vast-ready', '');
  const hostBox = await host.boundingBox();
  if (!hostBox) throw new Error('划词按钮不可见');
  await page.mouse.click(hostBox.x + Math.min(16, hostBox.width / 2), hostBox.y + Math.min(16, hostBox.height / 2));
  return host;
}

async function readSelectionPanel(serviceWorker: Worker): Promise<PanelSnapshot | null> {
  return serviceWorker.evaluate(async ({ pattern }) => {
    const readSnapshot = (): PanelSnapshot | null => {
      const host = document.querySelector<CapturedHost>('[data-vast-selection-host]');
      const root = host?.__vastCapturedShadow;
      if (!host || !root) return null;
      const toast = root.querySelector<HTMLElement>('.copy-toast');
      const result = root.querySelector<HTMLElement>('[data-result]');
      return {
        actions: Array.from(root.querySelectorAll<HTMLButtonElement>('.result-actions [data-action]'), (button) => {
          const rect = button.getBoundingClientRect();
          return {
            action: button.getAttribute('data-action') ?? '',
            label: button.getAttribute('aria-label') ?? '',
            pressed: button.getAttribute('aria-pressed'),
            disabled: button.disabled,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        }),
        toast: { text: toast?.textContent ?? '', hidden: toast?.hidden === true },
        result: result?.textContent ?? '',
      };
    };
    const [tab] = await chrome.tabs.query({ url: pattern });
    if (tab?.id === undefined) return null;
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readSnapshot });
    return (injection?.result ?? null) as PanelSnapshot | null;
  }, { pattern: FIXTURE_TAB_PATTERN });
}

async function readSelectionPanelOrThrow(serviceWorker: Worker): Promise<PanelSnapshot> {
  const panel = await readSelectionPanel(serviceWorker);
  if (!panel) throw new Error('无法读取划词面板：closed shadow 捕获失败或面板已关闭');
  return panel;
}

/** 用真实鼠标点击面板内的动作按钮（与既有用例的触发方式一致）。 */
async function clickPanelAction(page: Page, serviceWorker: Worker, action: string): Promise<void> {
  const panel = await readSelectionPanelOrThrow(serviceWorker);
  const target = panel.actions.find((item) => item.action === action);
  if (!target || target.width <= 0 || target.height <= 0) throw new Error(`划词面板动作按钮不可见: ${action}`);
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
}

/**
 * 在页面内轮询某动作按钮的 aria-pressed，翻转瞬间一并带回 toast 内容
 * （toast 1.5s 后自动隐藏，页内轮询保证能观察到）。
 */
async function waitForActionPressed(serviceWorker: Worker, action: string): Promise<PressedProbe> {
  return serviceWorker.evaluate(async ({ pattern, action: actionName, waitMs }) => {
    const waitForPressed = async (name: string, timeoutMs: number): Promise<PressedProbe> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const host = document.querySelector<CapturedHost>('[data-vast-selection-host]');
        const root = host?.__vastCapturedShadow;
        const button = root?.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
        const toast = root?.querySelector<HTMLElement>('.copy-toast');
        const pressed = button?.getAttribute('aria-pressed') ?? null;
        if (pressed === 'true' || Date.now() >= deadline) {
          return { pressed, toastText: toast?.textContent ?? '', toastHidden: toast?.hidden === true };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const [tab] = await chrome.tabs.query({ url: pattern });
    if (tab?.id === undefined) throw new Error('找不到划词 fixture 标签页');
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: waitForPressed,
      args: [actionName, waitMs],
    });
    if (!injection) throw new Error('无法读取划词面板状态');
    return injection.result as PressedProbe;
  }, { pattern: FIXTURE_TAB_PATTERN, action, waitMs: PRESS_WAIT_MS });
}

async function readVocabularyEntryCount(serviceWorker: Worker): Promise<number> {
  return serviceWorker.evaluate(async () => {
    const value = await chrome.storage.local.get('vocabularyBook');
    return ((value as { vocabularyBook?: { entries?: unknown[] } }).vocabularyBook?.entries ?? []).length;
  });
}

test('划词浮层底部提供朗读/重试/复制/加入生词动作且 aria-label 可访问，朗读点击无异常', async ({
  context, server, serviceWorker, openExtensionPage, errors,
}) => {
  await configureCustomAiEngine(openExtensionPage, server);
  const page = await openFixturePage(context, server, serviceWorker);

  await selectSentence(page);
  const host = await openSelectionPanel(page);
  await expect(host).toHaveAttribute('data-vast-state', 'translated');

  const panel = await readSelectionPanelOrThrow(serviceWorker);
  expect(panel.actions.map((item) => item.action)).toEqual(['speak', 'retry', 'copy', 'add-vocabulary']);
  const labelByAction = new Map(panel.actions.map((item) => [item.action, item.label]));
  // speak/add-vocabulary 标签固定中文；retry/copy 经 chrome.i18n，随浏览器 UI 语言返回中文或英文。
  expect(labelByAction.get('speak')).toBe('朗读原文');
  expect(labelByAction.get('retry')).toMatch(/^(重试|Retry)$/);
  expect(labelByAction.get('copy')).toMatch(/^(复制|Copy)$/);
  expect(labelByAction.get('add-vocabulary')).toBe('加入生词');
  for (const item of panel.actions) {
    expect(item.label.length, `${item.action} 的 aria-label 不应为空`).toBeGreaterThan(0);
  }
  expect(panel.actions.find((item) => item.action === 'speak')?.pressed).toBe('false');
  expect(panel.actions.find((item) => item.action === 'add-vocabulary')?.pressed).toBe('false');

  // headless 环境可能没有语音包：aria-pressed 变 true（开始朗读）或保持 false 都允许。
  await clickPanelAction(page, serviceWorker, 'speak');
  const spoken = await readSelectionPanelOrThrow(serviceWorker);
  const spokenState = spoken.actions.find((item) => item.action === 'speak');
  expect(['true', 'false']).toContain(spokenState?.pressed ?? null);
  expect(spokenState?.label).toMatch(/^(朗读原文|停止朗读)$/);

  // 再次点击（切换停止或重试朗读）与关闭面板都不得抛错；
  // errors fixture 在收尾统一断言页面/控制台/Service Worker 零错误。
  await clickPanelAction(page, serviceWorker, 'speak');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-vast-selection-host]')).toHaveCount(0);
  expect(errors.page).toHaveLength(0);
  expect(errors.console).toHaveLength(0);
});

test('加入生词端到端成功反馈，重复加词仍成功，新面板恢复未按下状态', async ({
  context, server, serviceWorker, openExtensionPage, errors,
}) => {
  await configureCustomAiEngine(openExtensionPage, server);
  const page = await openFixturePage(context, server, serviceWorker);

  // 首次加词：aria-pressed 反馈只有后台 save-vocabulary-entry 成功后才出现。
  await selectSentence(page);
  const host = await openSelectionPanel(page);
  await expect(host).toHaveAttribute('data-vast-state', 'translated');
  await clickPanelAction(page, serviceWorker, 'add-vocabulary');
  const added = await waitForActionPressed(serviceWorker, 'add-vocabulary');
  expect(added.pressed).toBe('true');
  expect(added.toastHidden).toBe(false);
  expect(added.toastText).toBe('已加入生词本');

  // 端到端核对消息与存储：划词生词确实写入 chrome.storage.local。
  await expect.poll(() => readVocabularyEntryCount(serviceWorker), { message: '生词本应保存 1 条划词生词' }).toBe(1);
  const storedWord = await serviceWorker.evaluate(async () => {
    const value = await chrome.storage.local.get('vocabularyBook');
    return ((value as { vocabularyBook?: { entries?: Array<{ word?: string }> } }).vocabularyBook?.entries ?? [])[0]?.word ?? '';
  });
  expect(storedWord).toContain(SELECTION_TEXT_PART);

  // 同页同词再次划词加词：duplicate 也算成功，存储仍只有 1 条。
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-vast-selection-host]')).toHaveCount(0);
  await selectSentence(page);
  const reopened = await openSelectionPanel(page);
  await expect(reopened).toHaveAttribute('data-vast-state', 'translated');
  await clickPanelAction(page, serviceWorker, 'add-vocabulary');
  const duplicated = await waitForActionPressed(serviceWorker, 'add-vocabulary');
  expect(duplicated.pressed).toBe('true');
  expect(duplicated.toastText).toBe('已在生词本');
  expect(await readVocabularyEntryCount(serviceWorker)).toBe(1);

  // 关闭后重新划词：新面板实例的 add-vocabulary 恢复未按下状态，toast 为空。
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-vast-selection-host]')).toHaveCount(0);
  await selectSentence(page);
  const freshHost = await openSelectionPanel(page);
  await expect(freshHost).toHaveAttribute('data-vast-state', 'translated');
  const fresh = await readSelectionPanelOrThrow(serviceWorker);
  expect(fresh.actions.find((item) => item.action === 'add-vocabulary')?.pressed).toBe('false');
  expect(fresh.toast.text).toBe('');
  expect(fresh.toast.hidden).toBe(true);
  expect(errors.page).toHaveLength(0);
  expect(errors.console).toHaveLength(0);
});
