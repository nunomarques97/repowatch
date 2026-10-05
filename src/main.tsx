import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './app/app.css';
import './features/dashboard/dashboard.css';
import './features/settings/settings.css';
import './features/palette/palette.css';
import './features/detail/detail.css';
import { App } from './app/App';
import { applyTheme } from './app/theme';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root is missing from index.html');
}

// Follow the OS theme before the first paint; Settings may override it once loaded.
applyTheme('system');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
