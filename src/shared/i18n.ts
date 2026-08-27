export type Translator = (key: string, substitutions?: string | string[]) => string;

const fallbackMessages: Record<string, string> = {
  popupKicker: '双语校样台', popupCurrentPage: '当前页面', targetLanguage: '目标语言', translationScope: '翻译范围', displayMode: '显示模式',
  mainContent: '主要内容', wholePage: '整个页面', bilingual: '双语对照', translationOnly: '仅译文', ready: '就绪',
  actionTranslatePage: '翻译当前页面', actionRestore: '恢复原文', actionRetry: '重试', actionSettings: '设置', statusTranslating: '翻译中…',
  statusStarted: '已开始翻译，关闭窗口不会中断', statusFailed: '翻译失败', statusPartial: '已完成 $1/$2，失败 $3',
  statusProgress: '翻译中 $1/$2', statusError: '翻译失败 $1/$2', statusComplete: '已完成 $1/$2', shortcut: '快捷切换',
  optionsKicker: '连接与阅读偏好', optionsApiConnection: 'API 连接', model: '模型', connectionDestination: '连接目的：', invalidAddress: '无效地址',
  apiKeyHelp: 'API Key 仅保存在浏览器本地存储中；扩展不会把密钥返回给网页。', optionsKeySaved: '已保存 API Key；留空会保留现有密钥。',
  connectionNoticeTitle: '连接提示', connectionNotice: '远程服务必须使用 HTTPS。HTTP 只允许本机回环地址 localhost、127.0.0.1 或 ::1。',
  actionTestConnection: '测试连接', statusTesting: '测试中…', optionsReadingPreferences: '阅读偏好', defaultMode: '默认模式', translationPosition: '译文位置',
  positionAfter: '原文之后', positionBefore: '原文之前', defaultScope: '默认范围', limitedContext: '有限上下文', limitedContextLabel: '划词时使用有限上下文',
  customInstruction: '自定义翻译要求', privacyWarning: '翻译页面或划词时，选中的文本及有限上下文会发送到你配置的 API 服务。请勿翻译密码、身份凭据或其他敏感内容。',
  unchanged: '设置尚未修改', actionSaveSettings: '保存设置', statusSaving: '保存中…', actionClearApiKey: '清除 API Key', statusKeyCleared: 'API Key 已清除',
  confirmClearKey: '再次点击确认清除密钥', actionConfirmClearKey: '确认清除 API Key',
  optionsDataManagement: '数据管理', actionImport: '导入配置', actionExport: '导出配置', actionClearCache: '清理缓存', confirmClear: '再次点击确认清理', actionConfirmClear: '确认清理',
  statusConnectionTesting: '正在测试连接…', statusConnectionSuccess: '连接成功', statusConnectionFailed: '连接失败，请检查配置', statusSaved: '设置已保存', statusSaveFailed: '设置保存失败', cacheCleared: '缓存已清理',
  importReadFailed: '配置文件读取失败', importOriginChanged: 'Base URL 来源已变化，API Key 已清空，请重新输入 API Key', importReady: '配置已导入，请检查后保存', importInvalid: '配置文件无效', pageUnavailable: '无法访问当前页面',
  selectionTranslate: '翻译选中内容', selectionDialog: '划词翻译', actionClose: '关闭', actionCopy: '复制', limitedContextShort: '有限上下文', preparing: '准备翻译…',
};

function substitute(message: string, substitutions?: string | string[]): string {
  const values = typeof substitutions === 'string' ? [substitutions] : substitutions ?? [];
  return values.reduce((result, value, index) => result.replaceAll(`$${index + 1}`, value), message);
}

export function createTranslator(getMessage?: (key: string, substitutions?: string | string[]) => string): Translator {
  return (key, substitutions) => getMessage?.(key, substitutions) || substitute(fallbackMessages[key] ?? key, substitutions);
}
