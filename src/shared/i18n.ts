export type Translator = (key: string, substitutions?: string | string[]) => string;

const fallbackMessages: Record<string, string> = {
  popupKicker: '双语校样台', popupCurrentPage: '当前页面', translationEngine: '翻译引擎', sourceLanguage: '源语言', targetLanguage: '目标语言', translationScope: '翻译范围', displayMode: '显示模式',
  mainContent: '主要内容', wholePage: '整个页面', bilingual: '双语对照', translationOnly: '仅译文', ready: '就绪',
  actionTranslatePage: '翻译当前页面', actionRestore: '恢复原文', actionRetry: '重试', actionSettings: '设置', statusTranslating: '翻译中…',
  statusStarted: '已开始翻译，关闭窗口不会中断', statusFailed: '翻译失败', statusPartial: '已完成 $1/$2，失败 $3',
  statusProgress: '翻译中 $1/$2', statusError: '翻译失败 $1/$2', statusComplete: '已完成 $1/$2', shortcut: '快捷切换',
  optionsKicker: '连接与阅读偏好', optionsApiConnection: 'API 连接', model: '模型', connectionDestination: '连接目的：', invalidAddress: '无效地址',
  apiKeyHelp: 'API Key 仅保存在浏览器本地存储中；扩展不会把密钥返回给网页。', optionsKeySaved: '已保存 API Key；留空会保留现有密钥。',
  connectionNoticeTitle: '连接提示', connectionNotice: '远程服务必须使用 HTTPS。HTTP 只允许本机回环地址 localhost、127.0.0.1 或 ::1。',
  actionTestConnection: '测试连接', statusTesting: '测试中…', optionsReadingPreferences: '阅读偏好', defaultMode: '默认模式', translationPosition: '译文位置',
  positionAfter: '原文之后', positionBefore: '原文之前', defaultScope: '默认范围', limitedContext: '有限上下文', limitedContextLabel: '划词时使用有限上下文',
  limitedContextHelp: '发送选区所在段落的有限文本帮助消歧，不翻译上下文本身。', selectionPopupEnabled: '显示划词悬浮按钮', inlineSelectionModifier: '选区内联翻译快捷键', modifierOff: '关闭',
  customInstruction: '自定义翻译要求', privacyWarning: '翻译页面或划词时，选中的文本及有限上下文会发送到你配置的 API 服务。请勿翻译密码、身份凭据或其他敏感内容。',
  unchanged: '设置尚未修改', actionSaveSettings: '保存设置', statusSaving: '保存中…', actionClearApiKey: '清除 API Key', statusKeyCleared: 'API Key 已清除',
  confirmClearKey: '再次点击确认清除密钥', actionConfirmClearKey: '确认清除 API Key',
  optionsDataManagement: '数据管理', actionImport: '导入配置', actionExport: '导出配置', actionClearCache: '清理缓存', confirmClear: '再次点击确认清理', actionConfirmClear: '确认清理',
  statusConnectionTesting: '正在测试连接…', statusConnectionSuccess: '连接成功', statusConnectionFailed: '连接失败，请检查配置', statusSaved: '设置已保存', statusSaveFailed: '设置保存失败', cacheCleared: '缓存已清理',
  importReadFailed: '配置文件读取失败', importOriginChanged: 'Base URL 来源已变化，API Key 已清空，请重新输入 API Key', importReady: '配置已导入，请检查后保存', importInvalid: '配置文件无效', pageUnavailable: '无法访问当前页面',
  selectionTranslate: '翻译选中内容', selectionDialog: '划词翻译', actionClose: '关闭', actionCopy: '复制', limitedContextShort: '有限上下文', preparing: '准备翻译…',
  builtinEngines: '内置翻译引擎', googleDefaultFree: '内置', bingBackup: '内置', builtin: '内置', activeDefault: '当前默认', enabled: '启用', setDefault: '设为默认',
  customAiEngines: '自定义 AI', customAiDescription: '可添加多个 OpenAI 兼容服务，每个实例独立保存连接与密钥。', engineName: '名称', saveEngine: '保存实例', moveUp: '上移', moveDown: '下移', deleteEngine: '删除实例', confirmDeleteEngine: '再次点击确认删除', confirmDeleteEngineAction: '确认删除实例', addCustomAi: '新增自定义 AI', newCustomAi: '自定义 AI',
  engineOriginChanged: 'Base URL 来源已变化，旧 API Key 不会沿用，请重新输入 API Key。', instructionCustomOnly: '自定义翻译要求仅对自定义 AI 生效；Google 和 Bing 会忽略此项。', savePreferences: '保存阅读偏好',
  statusEngineSaved: '实例已保存', statusEngineUpdated: '引擎状态已更新', statusActiveChanged: '默认引擎已更新', statusOrderSaved: '引擎顺序已保存', statusEngineDeleted: '实例已删除', importApplied: '配置已安全导入',
  translateShortcut: '翻译 (Alt + A)', showOriginal: '显示原文 (Alt + A)', modeToggleHelp: '切换双语对照与仅译文', settingsNavigation: '设置导航', optionsTitle: '翻译设置', appearanceTheme: '外观主题', dataPrivacy: '数据隐私', themeDescription: '五套主题共享相同功能结构，点击后立即保存。', themeSaved: '主题已保存',
  themePearlDescription: '浅蓝珍珠，安静轻盈的默认阅读主题。', themeCommandDescription: '深色命令台，快速且键盘优先。', themeSageDescription: '鼠尾草绿，温暖友好的全球阅读感。', themeEditorialDescription: '奶油紫与衬线标题，内容编辑感更强。', themePrecisionDescription: '高精度蓝，理性、可靠且更方正。',
};

function substitute(message: string, substitutions?: string | string[]): string {
  const values = typeof substitutions === 'string' ? [substitutions] : substitutions ?? [];
  return values.reduce((result, value, index) => result.replaceAll(`$${index + 1}`, value), message);
}

export function createTranslator(getMessage?: (key: string, substitutions?: string | string[]) => string): Translator {
  return (key, substitutions) => getMessage?.(key, substitutions) || substitute(fallbackMessages[key] ?? key, substitutions);
}
