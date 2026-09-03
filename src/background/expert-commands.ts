import type { Expert } from '../shared/experts';
import type { Settings } from '../shared/config';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeString(value: unknown, max = 10_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isSafeId(value: unknown): value is string {
  return isSafeString(value, 200) && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export async function handleExpertCommand(
  message: Record<string, unknown>,
  settings: Settings,
  saveSettings: (settings: Settings) => Promise<void>,
): Promise<unknown> {
  const experts = settings.experts ?? [];
  if (message.type === 'set-expert-enabled') {
    if (!hasOnlyKeys(message, ['type', 'expertId', 'enabled']) || !isSafeId(message.expertId) || typeof message.enabled !== 'boolean') return { ok: false, error: '消息格式无效' };
    if (!experts.some((expert) => expert.id === message.expertId)) return { ok: false, error: 'AI 专家不存在' };
    await saveSettings({ ...settings, experts: experts.map((expert) => expert.id === message.expertId ? { ...expert, enabled: message.enabled as boolean } : expert) });
    return { ok: true };
  }
  if (message.type === 'upsert-expert') {
    if (!hasOnlyKeys(message, ['type', 'expert']) || !isRecord(message.expert)) return { ok: false, error: '消息格式无效' };
    const expert = message.expert as unknown as Expert;
    if (expert.kind !== 'custom' || !/^custom-expert-[a-z0-9-]{1,70}$/.test(expert.id) || !isSafeString(expert.name, 120) || typeof expert.description !== 'string' || !isSafeString(expert.prompt, 20_000) || typeof expert.enabled !== 'boolean' || !Number.isInteger(expert.order)) return { ok: false, error: '自定义 AI 专家配置无效' };
    const next = experts.some((item) => item.id === expert.id) ? experts.map((item) => item.id === expert.id ? expert : item) : [...experts, expert];
    await saveSettings({ ...settings, experts: next });
    return { ok: true };
  }
  if (message.type === 'delete-expert') {
    if (!hasOnlyKeys(message, ['type', 'expertId']) || !isSafeId(message.expertId)) return { ok: false, error: '消息格式无效' };
    const expert = experts.find((item) => item.id === message.expertId);
    if (!expert || expert.kind !== 'custom') return { ok: false, error: '只能删除自定义 AI 专家' };
    const activeExpertByEngine = Object.fromEntries(Object.entries(settings.activeExpertByEngine ?? {}).filter(([, id]) => id !== expert.id));
    await saveSettings({ ...settings, experts: experts.filter((item) => item.id !== expert.id), activeExpertByEngine });
    return { ok: true };
  }
  return undefined;
}
