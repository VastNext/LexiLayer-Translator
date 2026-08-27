import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export type ApiMode = 'success' | '401' | '429' | '500' | 'invalid-json' | 'invalid-sse' | 'delay';

export interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface MockServer {
  origin: string;
  baseUrl: string;
  fixtureUrl: string;
  batchFixtureUrl: string;
  networkFixtureUrl: string;
  requests: RecordedRequest[];
  hits: string[];
  maxConcurrency: () => number;
  setMode(mode: ApiMode): void;
  releaseDelay(): void;
  close(): Promise<void>;
}

function fixtureHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vast E2E Fixture</title></head>
  <body><header><p id="outside">Header must stay outside main scope.</p></header>
  <main><article><h1>Fixture article</h1>
    <p id="first">First paragraph for translation.</p>
    <p id="second">Second paragraph for progress.</p>
    <p id="selection">Select this sentence with a real mouse gesture.</p>
    <input id="editor" value="Input selection must not translate">
    <div id="dynamic-root"></div>
  </article></main></body></html>`;
}

function batchFixtureHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Batch Fixture</title></head><body><header id="header"></header><main><article>
  ${Array.from({ length: 10 }, (_, index) => `<p id="batch-${index}">Visible paragraph ${index}</p>`).join('')}
  <div style="height:5000px;display:block"></div><p id="offscreen">Offscreen paragraph</p><div id="dynamic"></div>
  </article></main></body></html>`;
}

function segmentsFrom(body: Record<string, unknown>): Array<{ id: string; text: string }> {
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined;
  const user = messages?.find((message) => message.role === 'user')?.content ?? '';
  if (body.stream === true) return [{ id: 'selection', text: user }];
  try {
    const parsed = JSON.parse(user) as { segments?: Array<{ id: string; text: string }> };
    return parsed.segments ?? [];
  } catch {
    return [];
  }
}

function translateToChinese(text: string): string {
  const translations: Record<string, string> = {
    'Fixture article': '测试文章',
    'Header must stay outside main scope.': '页眉也应被翻译。',
    'First paragraph for translation.': '用于翻译的第一段。',
    'Second paragraph for progress.': '用于进度测试的第二段。',
    'Select this sentence with a real mouse gesture.': '请使用真实鼠标手势选择这句话。',
    'Dynamically added paragraph.': '动态添加的段落。',
    'Changed source paragraph.': '修改后的原文段落。',
    'Offscreen paragraph': '屏幕外段落',
  };
  const visible = /^Visible paragraph (\d+)$/.exec(text);
  if (visible) return `可见段落 ${visible[1]}`;
  return translations[text] ?? `中文译文：${text}`;
}

export async function startMockServer(): Promise<MockServer> {
  let mode: ApiMode = 'success';
  let releaseDelay: (() => void) | undefined;
  let activeRequests = 0;
  let maxConcurrency = 0;
  const requests: RecordedRequest[] = [];
  const hits: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    hits.push(`${request.method ?? 'UNKNOWN'} ${url.pathname}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Private-Network': 'true',
      });
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/fixture') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(fixtureHtml());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/fixture-batch') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(batchFixtureHtml()); return;
    }
    if (request.method === 'GET' && url.pathname === '/fixture-network') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="en"><main><p id="hello">hello</p></main></html>');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/v1/chat/completions')) {
      response.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ path: url.pathname, headers: request.headers, body });
    activeRequests += 1;
    maxConcurrency = Math.max(maxConcurrency, activeRequests);
    response.once('finish', () => { activeRequests -= 1; });

    if (mode === 'delay') await new Promise<void>((resolve) => { releaseDelay = resolve; });
    if (mode === '401' || mode === '429' || mode === '500') {
      const status = Number(mode);
      response.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '0' } : {}) });
      response.end(JSON.stringify({ error: { message: `mock ${status}` } }));
      return;
    }
    if (mode === 'invalid-json') {
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      response.end('{invalid');
      return;
    }

    const segments = segmentsFrom(body);
    if (body.stream === true) {
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (mode === 'invalid-sse') { response.end('data: {invalid\n\n'); return; }
      const translated = translateToChinese(segments[0]?.text ?? '');
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: translated } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    const content = JSON.stringify({ translations: segments.map(({ id, text }) => ({ id, text: translateToChinese(text) })) });
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('模拟服务器启动失败');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    fixtureUrl: `${origin}/fixture`,
    batchFixtureUrl: `${origin}/fixture-batch`,
    networkFixtureUrl: `${origin}/fixture-network`,
    requests,
    hits,
    maxConcurrency: () => maxConcurrency,
    setMode(nextMode) { mode = nextMode; },
    releaseDelay() { releaseDelay?.(); releaseDelay = undefined; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
