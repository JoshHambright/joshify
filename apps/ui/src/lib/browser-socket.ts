/**
 * The real `WebSocket`, behind the narrow shape the store expects.
 *
 * The adapter exists so `connection.ts` never mentions a DOM type: its tests
 * then run in plain Node against a fake, which is where the reconnect logic
 * actually gets exercised. The alternative — widening `SocketLike` until a
 * real `WebSocket` structurally satisfies it — would drag `MessageEvent` and
 * `Event` into the store's signature to save these fifteen lines.
 */
import type { SocketFactory, SocketLike } from './connection.js';

export const browserSocket: SocketFactory = (url) => {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    send: (data) => {
      ws.send(data);
    },
    close: () => {
      ws.close();
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onclose = () => socket.onclose?.();
  ws.onerror = () => socket.onerror?.();
  ws.onmessage = (event: MessageEvent<unknown>) =>
    socket.onmessage?.({ data: event.data });
  return socket;
};
