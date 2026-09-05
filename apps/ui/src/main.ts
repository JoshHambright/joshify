/**
 * The kiosk entry point.
 *
 * The three things tied to the document are constructed here and nowhere else
 * — the socket connection, the command client, and the device source —
 * because each is a singleton, and a component that reached for a global
 * version of any of them would be untestable for it.
 *
 * The theme is not among them any more: it arrives on the wire per track
 * (P3-13), so `App` owns applying it and defaults its target to the document
 * root. Writing it here as well would mean two writers for one set of
 * properties.
 */
import { mount } from 'svelte';
import App from './App.svelte';
import { browserSocket } from './lib/browser-socket.js';
import { createCommandClient } from './lib/commands.js';
import { createConnection } from './lib/connection.js';
import { createDeviceSource } from './lib/device-source.js';
import './styles/tokens.css';

const socketUrl = (): string => {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws`;
};

const target = document.querySelector('#panel');
if (target === null) throw new Error('#panel is missing from index.html');

const connection = createConnection({
  url: socketUrl(),
  socket: browserSocket,
});

// Bound so `fetch` keeps its `window` receiver, and narrowed to the shape
// these clients declare rather than the whole DOM signature.
const httpFetch = window.fetch.bind(window);

const client = createCommandClient({
  fetch: (input, init) => httpFetch(input, init),
});

const devices = createDeviceSource({
  fetch: (input) => httpFetch(input),
});

mount(App, { target, props: { connection, client, devices } });
