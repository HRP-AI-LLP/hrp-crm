/** Node stand-in for `cloudflare:sockets` in tests: the same connect() over node:net / node:tls. */
import net from 'node:net';
import tls from 'node:tls';
import { Readable, Writable } from 'node:stream';

export function connect(address: { hostname: string; port: number }, opts: { secureTransport?: 'on' | 'off' | 'starttls' } = {}) {
  const sock = opts.secureTransport === 'on' ? tls.connect({ host: address.hostname, port: address.port, servername: address.hostname }) : net.connect({ host: address.hostname, port: address.port });
  return {
    readable: Readable.toWeb(sock) as unknown as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(sock) as unknown as WritableStream<Uint8Array>,
    opened: new Promise((r) => sock.once('connect', r)),
    closed: new Promise((r) => sock.once('close', r)),
    close: async () => void sock.destroy(),
  };
}
