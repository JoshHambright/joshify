/**
 * The kiosk entry point.
 *
 * Two things are constructed here and nowhere else — the socket connection and
 * the theme applier — because both are singletons tied to the document, and
 * every component that needs them should be handed them rather than reaching
 * for a global.
 */
import { mount } from 'svelte';
import App from './App.svelte';
import { browserSocket } from './lib/browser-socket.js';
import { createConnection } from './lib/connection.js';
import { createThemeApplier } from './lib/theme.js';
import './styles/tokens.css';

const socketUrl = (): string => {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws`;
};

const target = document.querySelector('#panel');
if (target === null) throw new Error('#panel is missing from index.html');

// Applied to the document root rather than the app root: the plate's
// `backdrop-filter` and the body background both read these, and the body is
// outside the app's subtree.
createThemeApplier(document.documentElement);

const connection = createConnection({
  url: socketUrl(),
  socket: browserSocket,
});

mount(App, { target, props: { connection } });
