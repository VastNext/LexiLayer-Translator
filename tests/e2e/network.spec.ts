import { expect, test } from './fixtures';

interface NetworkResult { status?: number; text?: string; error?: string }

test.describe.configure({ mode: 'serial' });

test('Google 匿名端点可经代理翻译 hello @network', async ({ serviceWorker }) => {
  expect(process.env.VAST_E2E_PROXY, 'Google 网络验证必须显式设置 VAST_E2E_PROXY').toBe('http://127.0.0.1:7890');
  const result = await serviceWorker.evaluate(async (): Promise<NetworkResult> => {
    try {
      const body = new URLSearchParams(); body.append('q', 'hello');
      const response = await fetch('https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&sl=en&tl=zh-CN', {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
      });
      if (response.status === 429) return { status: 429 };
      const payload = await response.json() as unknown;
      const read = (value: unknown): string | undefined => typeof value === 'string' ? value : Array.isArray(value) ? value.map(read).find((item) => item !== undefined) : undefined;
      return { status: response.status, text: read(payload) };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  });
  console.log(`Google 代理可用性：${JSON.stringify(result)}`);
  expect(result.error, `Google 网络错误：${result.error}`).toBeUndefined();
  expect(result.status, 'Google 代理可达但被限流（429），可用性验证失败').toBe(200);
  expect(result.text?.trim(), 'Google 返回 200 但没有有效译文').toBeTruthy();
});

test('Bing Edge 端点可用性：可翻译 hello @network', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async (): Promise<NetworkResult> => {
    try {
      const response = await fetch('https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false&from=en', {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(['hello']),
      });
      const payload = await response.json() as Array<{ translations?: Array<{ text?: string }> }>;
      return { status: response.status, text: payload[0]?.translations?.[0]?.text };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  });
  console.log(`Bing：${JSON.stringify(result)}`);
  expect(result.error, `Bing 服务网络错误：${result.error}`).toBeUndefined();
  expect(result.status, `Bing 服务拒绝请求，状态码 ${result.status}`).toBe(200);
  expect(result.text?.trim(), 'Bing 返回 200 但没有有效译文').toBeTruthy();
});
