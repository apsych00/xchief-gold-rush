import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ClaimPage from './ClaimPage.jsx';
import './styles.css';
import './styles-3d.css';
import './profile-screen.css';

// /claim/<token> (ticket C9): a separate tree, never App's own game session - no router
// library, the client routes on location.pathname exactly like the ticket calls for.
const claimMatch = window.location.pathname.match(/^\/claim\/([^/]+)\/?$/);
const standalonePage = claimMatch ? <ClaimPage token={decodeURIComponent(claimMatch[1])} /> : null;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>{standalonePage || <App />}</React.StrictMode>,
);
