import { createRoot } from 'react-dom/client';
import { PopupApp } from './PopupApp';
import '../ui.css';
import { createTranslator } from '../shared/i18n';
import { createPopupApi } from './api';

const api = createPopupApi(chrome);
const t = createTranslator(chrome.i18n.getMessage.bind(chrome.i18n));

document.title = t('extensionName');
createRoot(document.getElementById('root')!).render(<PopupApp api={api} t={t} />);
