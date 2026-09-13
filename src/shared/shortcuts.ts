export const PAGE_TRANSLATION_COMMAND = 'translate_page';

export type ShortcutState =
  | { status: 'assigned'; shortcut: string; displayShortcut: string }
  | { status: 'unassigned' }
  | { status: 'unavailable'; reason?: string };

export interface BrowserIdentity {
  brands?: Array<{ brand: string }>;
  userAgent?: string;
}

export function formatShortcut(shortcut: string): string {
  return shortcut.split('+').join(' + ');
}

export function resolvePageTranslationShortcut(commands: unknown): ShortcutState {
  if (!Array.isArray(commands)) return { status: 'unavailable', reason: 'invalid-command' };

  let hasInvalidCommand = false;
  let command: Record<string, unknown> | undefined;
  for (const candidate of commands) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      hasInvalidCommand = true;
      continue;
    }
    const value = candidate as Record<string, unknown>;
    if (value.name === PAGE_TRANSLATION_COMMAND) {
      command = value;
      break;
    }
  }

  if (!command) {
    return { status: 'unavailable', reason: hasInvalidCommand ? 'invalid-command' : 'command-missing' };
  }

  const shortcut = command.shortcut;
  if (shortcut === '') return { status: 'unassigned' };
  if (typeof shortcut !== 'string' || shortcut.trim() === '') {
    return { status: 'unavailable', reason: 'invalid-shortcut' };
  }
  return { status: 'assigned', shortcut, displayShortcut: formatShortcut(shortcut) };
}

export function getShortcutSettingsUrl(identity?: BrowserIdentity): string {
  const isEdgeBrand = identity?.brands?.some(({ brand }) => /microsoft edge/i.test(brand)) ?? false;
  return isEdgeBrand || /Edg\//i.test(identity?.userAgent ?? '')
    ? 'edge://extensions/shortcuts'
    : 'chrome://extensions/shortcuts';
}
