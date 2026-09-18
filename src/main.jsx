import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ClaimPage from './ClaimPage.jsx';
import SharePage from './SharePage.jsx';
import './styles.css';
import './styles-3d.css';
import './profile-screen.css';

// /claim/<token> (ticket C9) and /s/<token> (ticket U4): separate trees, never App's own game
// session - no router library, the client routes on location.pathname exactly like the tickets call for.
const claimMatch = window.location.pathname.match(/^\/claim\/([^/]+)\/?$/);
const shareMatch = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
const standalonePage = claimMatch ? (
  <ClaimPage token={decodeURIComponent(claimMatch[1])} />
) : shareMatch ? (
  <SharePage token={decodeURIComponent(shareMatch[1])} />
) : null;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>{standalonePage || <App />}</React.StrictMode>,
);
