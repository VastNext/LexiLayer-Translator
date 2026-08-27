import { createRoot } from 'react-dom/client';
import { PopupApp } from './PopupApp';
import '../ui.css';
import { createTranslator } from '../shared/i18n';
import { createPopupApi } from './api';

const api = createPopupApi(chrome);

createRoot(document.getElementById('root')!).render(<PopupApp api={api} t={createTranslator(chrome.i18n.getMessage.bind(chrome.i18n))} />);
