import packageJson from '../package.json' with { type: 'json' };

export const manifest = {
  manifest_version: 3,
  name: '__MSG_extensionName__',
  description: '__MSG_extensionDescription__',
  version: packageJson.version,
  default_locale: 'zh_CN',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  permissions: ['storage', 'contextMenus', 'scripting'],
  host_permissions: ['<all_urls>'],
  action: {
    default_popup: 'popup.html',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  options_page: 'options.html',
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      // 单条目内 js 数组按声明顺序执行：控制器库 → 内联渲染器 → 装配层。
      // 拆成多个条目时 Chrome 不保证条目间顺序，合并才能锁定注入顺序。
      js: ['content.js', 'content-inline.js', 'content-main.js'],
      // 两套样式都是声明式注入的常驻样式：content.css 承载 legacy 渲染器与划词节点，
      // content-inline.css 承载内联渲染器。按需注入（Popup）必须与这里保持一致。
      css: ['content.css', 'content-inline.css'],
    },
  ],
  web_accessible_resources: [
    {
      resources: [
        'rules/google-search.json',
        'rules/bing-search.json',
        'rules/github.json',
        'rules/youtube.json',
        'rules/reddit.json',
        'rules/x.json',
        'rules/stackoverflow.json',
        'rules/substack.json', 'experts.json',
      ],
      matches: ['<all_urls>'],
    },
  ],
  commands: {
    translate_page: {
      suggested_key: {
        default: 'Alt+A',
      },
      description: '__MSG_commandTranslatePage__',
    },
  },
} as const;
