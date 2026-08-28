export const manifest = {
  manifest_version: 3,
  name: '__MSG_extensionName__',
  description: '__MSG_extensionDescription__',
  version: '0.2.0',
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
      js: ['content.js'],
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
        'rules/substack.json',
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
