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
  selectionFixtureUrl: string;
  adminFixtureUrl: string;
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

function selectionFixtureHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Selection Fixture</title></head><body><main>
    <nav aria-label="Breadcrumb"><ol>
      <li><a href="/"><span>Home</span></a></li>
      <li aria-hidden="true"><svg><path /></svg></li>
      <li><button><a href="/category"><span>Category</span></a></button></li>
      <li><a href="/category/image-generation"><span>Image Generation</span></a></li>
      <li><span aria-current="page">trainengine ai</span></li>
    </ol></nav>
    <div style="height:4200px"></div><p id="bottom-selection">Select this sentence with a real mouse gesture.</p>
  </main></body></html>`;
}

function adminFixtureHtml(): string {
  const items = ['Property details','Property access management','Property change history','Property data API quota history','Custom insights','Scheduled emails','Analytics Intelligence search history'];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Admin Fixture</title></head><body><main>
    <ga-secondary-nav role="navigation"><mat-tree role="tree"><mat-tree-node role="treeitem"><button id="reports-button"><span class="mdc-button__label"><span id="reports-label">Reports snapshot</span></span><span class="mat-focus-indicator"></span></button></mat-tree-node><mat-tree-node role="treeitem"><button id="leads-button"><span class="mdc-button__label"><mat-icon aria-hidden="true">arrow_drop_down</mat-icon><span id="leads-label">Generate leads</span></span></button></mat-tree-node></mat-tree></ga-secondary-nav>
    <div class="admin-link-group-list-container"><ga-admin-link-group><xap-card>
      <xap-card-header><xap-card-title><h3 id="property-title">Property</h3></xap-card-title></xap-card-header>
      <xap-card-sub-header><xap-card-subtitle><span id="property-description" class="admin-card-description">These settings affect your property <a id="property-help-link" href="#">What's a property?</a></span></xap-card-subtitle></xap-card-sub-header>
      <xap-card-content><mat-list class="admin-group-links-list">${items.map((text, index) => `<mat-list-item><span class="mdc-list-item__content"><ga-admin-link><div class="admin-link"><a role="link" id="admin-link-${index}"><img alt=""><div class="admin-link-text"><div id="admin-text-${index}" class="admin-link-text-title">${text}</div></div></a><ga-help-tooltip><xap-icon-trigger role="button" aria-label="Tooltip for ${text}"><mat-icon aria-hidden="true">help_outline</mat-icon></xap-icon-trigger></ga-help-tooltip></div></ga-admin-link></span></mat-list-item>`).join('')}</mat-list></xap-card-content>
    </xap-card></ga-admin-link-group></div>
  </main></body></html>`;
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
    if (request.method === 'GET' && url.pathname === '/fixture-selection') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(selectionFixtureHtml()); return;
    }
    if (request.method === 'GET' && url.pathname === '/fixture-admin') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(adminFixtureHtml()); return;
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
    selectionFixtureUrl: `${origin}/fixture-selection`,
    adminFixtureUrl: `${origin}/fixture-admin`,
    requests,
    hits,
    maxConcurrency: () => maxConcurrency,
    setMode(nextMode) { mode = nextMode; },
    releaseDelay() { releaseDelay?.(); releaseDelay = undefined; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
