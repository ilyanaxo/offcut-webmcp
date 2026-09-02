import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { workshopStore } from './workshop-store';
import { initializeWebMCP } from './webmcp';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Offcut requires its application root.');

createRoot(root).render(
  <StrictMode>
    <App store={workshopStore} />
  </StrictMode>,
);

const bridge = initializeWebMCP(workshopStore);
if (import.meta.hot) import.meta.hot.dispose(() => bridge.dispose());
