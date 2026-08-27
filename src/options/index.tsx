import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp';
import '../ui.css';
import { createTranslator } from '../shared/i18n';
import { createOptionsApi } from './api';

const v2Api = createOptionsApi(chrome);
const api = {
  ...v2Api,
  exportSettings(config: import('../shared/config').SafeSettings) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'vast-translator-config.json';
    anchor.click();
    URL.revokeObjectURL(url);
  },
};

createRoot(document.getElementById('root')!).render(<OptionsApp api={api} t={createTranslator(chrome.i18n.getMessage)} />);
