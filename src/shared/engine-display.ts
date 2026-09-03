export function engineDisplayName(engine: { id: string; kind: string; name: string; ready?: boolean }): string {
  const name = engine.kind === 'google' ? 'Google' : engine.kind === 'bing' ? 'Bing' : engine.name;
  return `${name}${engine.ready === false ? ' · 未配置' : ''}`;
}
