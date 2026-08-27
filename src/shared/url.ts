const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function assertSafeBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Base URL 无效');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL 必须使用 HTTP 或 HTTPS');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('Base URL 仅允许 HTTPS，HTTP 仅限本机回环地址');
  }
  return url;
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const url = assertSafeBaseUrl(baseUrl);

  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) {
    url.pathname += '/chat/completions';
  }

  return url.toString().replace(/\/$/, '');
}
