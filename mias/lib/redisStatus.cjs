'use strict';

const net = require('node:net');
const tls = require('node:tls');

function encodeCommand(parts) {
  const lines = [`*${parts.length}\r\n`];
  for (const part of parts) {
    const value = Buffer.from(String(part));
    lines.push(`$${value.length}\r\n`, value, '\r\n');
  }
  return Buffer.concat(lines.map(value => Buffer.isBuffer(value) ? value : Buffer.from(value)));
}

async function checkRedisStatus(url, {
  timeoutMs = 3000,
  connect = null,
} = {}) {
  const source = String(url || '').trim();
  if (!source) {
    return { attached: false, status: 'not_configured', message: 'REDIS_URL is not set' };
  }

  let parsed;
  try { parsed = new URL(source); } catch {
    return { attached: false, status: 'error', message: 'REDIS_URL_INVALID' };
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    return { attached: false, status: 'error', message: 'REDIS_URL_INVALID' };
  }

  const commands = [];
  let username = '';
  let password = '';
  try {
    username = decodeURIComponent(parsed.username || '');
    password = decodeURIComponent(parsed.password || '');
  } catch {
    return { attached: false, status: 'error', message: 'REDIS_URL_INVALID' };
  }
  if (password) commands.push(username ? ['AUTH', username, password] : ['AUTH', password]);
  const db = parsed.pathname.replace(/^\/+/, '');
  if (db) {
    if (!/^\d+$/.test(db)) return { attached: false, status: 'error', message: 'REDIS_URL_INVALID' };
    if (Number(db) !== 0) commands.push(['SELECT', db]);
  }
  commands.push(['PING']);

  return new Promise(resolve => {
    let socket;
    let buffer = '';
    let replies = 0;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch {}
      resolve(result);
    };
    const onConnect = () => {
      try { socket.write(Buffer.concat(commands.map(encodeCommand))); }
      catch { finish({ attached: false, status: 'error', message: 'REDIS_REQUEST_FAILED' }); }
    };

    try {
      const port = Number(parsed.port) || 6379;
      socket = connect
        ? connect(parsed, timeoutMs)
        : parsed.protocol === 'rediss:'
          ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname, rejectUnauthorized: true })
          : net.connect({ host: parsed.hostname, port });
      socket.setTimeout(timeoutMs);
      socket.once(parsed.protocol === 'rediss:' ? 'secureConnect' : 'connect', onConnect);
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let boundary;
        while ((boundary = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (line.startsWith('-')) {
            finish({ attached: false, status: 'error', message: 'REDIS_AUTH_OR_PING_FAILED' });
            return;
          }
          replies += 1;
          if (replies >= commands.length) {
            finish(line === '+PONG'
              ? { attached: true, status: 'connected', message: 'Redis ping succeeded' }
              : { attached: false, status: 'error', message: 'REDIS_PING_FAILED' });
            return;
          }
        }
      });
      socket.once('timeout', () => finish({ attached: false, status: 'error', message: 'REDIS_TIMEOUT' }));
      socket.once('error', error => {
        const code = String(error?.code || '').toUpperCase();
        finish({ attached: false, status: 'error', message: /^[A-Z0-9_]{2,32}$/.test(code) ? code : 'REDIS_UNAVAILABLE' });
      });
    } catch (error) {
      const code = String(error?.code || '').toUpperCase();
      finish({ attached: false, status: 'error', message: /^[A-Z0-9_]{2,32}$/.test(code) ? code : 'REDIS_UNAVAILABLE' });
    }
  });
}

module.exports = { checkRedisStatus };
