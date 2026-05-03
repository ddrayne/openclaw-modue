// Minimal WebSocket client using Node.js builtins only (http + crypto)
// No npm dependencies — works in the Modue plugin sandbox

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// Device identity — Ed25519 keypair for gateway pairing
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function signPayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(sig);
}

/**
 * Load or generate a persistent Ed25519 device identity via plugin storage.
 */
function loadOrCreateIdentity(storage, log) {
  const existing = storage.get('deviceIdentity');
  if (existing && existing.deviceId && existing.publicKeyPem && existing.privateKeyPem) {
    log.info(`Device identity loaded: ${existing.deviceId.slice(0, 8)}...`);
    return existing;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  const identity = { deviceId, publicKeyPem, privateKeyPem };
  storage.set('deviceIdentity', identity);
  log.info(`Device identity created: ${deviceId.slice(0, 8)}... (needs pairing approval)`);
  return identity;
}

// ---------------------------------------------------------------------------

class OpenClawClient {
  constructor(url, token, log, storage) {
    this.url = url;
    this.token = token;
    this.log = log;
    this.storage = storage;
    this.socket = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.seq = 0;
    this.connected = false;
    this.reconnectTimer = null;
    this.snapshot = null;
    this._buffer = Buffer.alloc(0);
    this._pingTimer = null;
  }

  connect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }

    this.log.info(`Connecting to OpenClaw at ${this.url}`);

    const parsed = new URL(this.url);
    const host = parsed.hostname || '127.0.0.1';
    const port = parseInt(parsed.port) || 18789;
    const path = parsed.pathname || '/';
    const wsKey = crypto.randomBytes(16).toString('base64');

    const req = http.request({
      host,
      port,
      path,
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': wsKey,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, socket, head) => {
      this.socket = socket;
      this._buffer = Buffer.alloc(0);
      this._awaitingChallenge = true;
      if (head.length > 0) this._buffer = head;

      this.log.info('WebSocket connected, waiting for challenge');

      // Keepalive: send WebSocket ping every 30s to prevent idle disconnect
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (!this.socket || this.socket.destroyed) return;
        try {
          const ping = Buffer.alloc(6);
          ping[0] = 0x89; // FIN + ping opcode
          ping[1] = 0x80; // masked, 0 payload
          crypto.randomBytes(4).copy(ping, 2);
          this.socket.write(ping);
        } catch {}
      }, 30000);

      socket.on('data', (data) => this._onData(data));

      socket.on('close', () => {
        this.log.info('Socket closed');
        this._stopPing();
        this.connected = false;
        this._emit('connection', { connected: false });
        this._scheduleReconnect();
      });

      socket.on('error', (err) => {
        this.log.error(`Socket error: ${err.message}`);
      });
    });

    req.on('error', (err) => {
      this.log.error(`Connection error: ${err.message}`);
      this._scheduleReconnect();
    });

    req.end();
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  disconnect() {
    this._stopPing();
    clearTimeout(this.reconnectTimer);
    // Drain in-flight RPCs: clear timeouts and reject so callers settle
    // immediately, instead of letting closures sit in Node's timer queue
    // for up to 15s and pin the discarded client object.
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      try { p.reject(new Error('Disconnected')); } catch {}
    }
    this.pending.clear();
    if (this.socket) {
      try {
        // Send close frame
        const closeFrame = Buffer.alloc(6);
        closeFrame[0] = 0x88; // FIN + opcode 8 (close)
        closeFrame[1] = 0x80; // masked, 0 length
        crypto.randomBytes(4).copy(closeFrame, 2);
        this.socket.write(closeFrame);
        this.socket.end();
      } catch {}
      this.socket = null;
    }
    this.connected = false;
  }

  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = `${method}-${++this.seq}`;
      this._sendFrame(JSON.stringify({ type: 'req', id, method, params }));
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(handler);
    return () => {
      const handlers = this.listeners.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    };
  }

  // --- WebSocket framing ---

  _sendFrame(text) {
    if (!this.socket || this.socket.destroyed) return;

    const payload = Buffer.from(text, 'utf-8');
    const mask = crypto.randomBytes(4);
    let header;

    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x81; // FIN + text opcode
      header[1] = 0x80 | payload.length; // masked
      mask.copy(header, 2);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      // Write 64-bit length (we only use lower 32 bits)
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
      mask.copy(header, 10);
    }

    // Mask payload
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    this.socket.write(Buffer.concat([header, masked]));
  }

  _onData(data) {
    this._buffer = Buffer.concat([this._buffer, data]);

    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const secondByte = this._buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this._buffer.length < 4) return; // need more data
        payloadLength = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this._buffer.length < 10) return;
        payloadLength = this._buffer.readUInt32BE(6); // ignore high 32 bits
        offset = 10;
      }

      let maskKey;
      if (isMasked) {
        if (this._buffer.length < offset + 4) return;
        maskKey = this._buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (this._buffer.length < offset + payloadLength) return; // need more data

      let payload = this._buffer.slice(offset, offset + payloadLength);
      if (isMasked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i] ^ maskKey[i % 4];
        }
      }

      // Consume this frame from the buffer
      this._buffer = this._buffer.slice(offset + payloadLength);

      if (opcode === 0x01) {
        // Text frame
        try {
          const frame = JSON.parse(payload.toString('utf-8'));
          this._handleFrame(frame);
        } catch {
          this.log.warn('Failed to parse frame');
        }
      } else if (opcode === 0x08) {
        // Close frame
        this.socket?.end();
      } else if (opcode === 0x09) {
        // Ping — respond with a *masked* pong. RFC 6455 §5.1: every frame
        // sent from client to server must be masked, including pong replies.
        // Without the mask bit, the OpenClaw gateway rejects the frame as
        // "Invalid WebSocket frame: MASK must be set" and closes the
        // connection. Same byte shape as the outbound ping above.
        const pong = Buffer.alloc(6);
        pong[0] = 0x8a; // FIN + pong opcode
        pong[1] = 0x80; // MASK + length 0
        crypto.randomBytes(4).copy(pong, 2);
        this.socket?.write(pong);
      }
      // Ignore other opcodes (pong, continuation, binary)
    }
  }

  _handleFrame(frame) {
    // Wait for connect.challenge before sending connect request
    if (this._awaitingChallenge && frame.type === 'event' && frame.event === 'connect.challenge') {
      this._awaitingChallenge = false;
      this.log.info('Challenge received, building device identity');

      const identity = loadOrCreateIdentity(this.storage, this.log);
      const nonce = frame.payload?.nonce || '';
      const scopes = ['operator.read', 'operator.write', 'operator.approvals'];
      const signedAtMs = Date.now();

      // Build v3 signature payload (must match gateway's buildDeviceAuthPayloadV3)
      const payloadStr = [
        'v3',
        identity.deviceId,
        'gateway-client',
        'cli',
        'operator',
        scopes.join(','),
        String(signedAtMs),
        this.token || '',
        nonce,
        'darwin',
        '',
      ].join('|');

      const signature = signPayload(identity.privateKeyPem, payloadStr);
      const publicKeyRaw = derivePublicKeyRaw(identity.publicKeyPem);

      this._sendFrame(JSON.stringify({
        type: 'req',
        id: 'connect-1',
        method: 'connect',
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: 'gateway-client',
            displayName: 'Modue Control Surface',
            version: '0.8.0',
            platform: 'darwin',
            mode: 'cli',
          },
          role: 'operator',
          scopes,
          device: {
            id: identity.deviceId,
            publicKey: base64UrlEncode(publicKeyRaw),
            signature,
            signedAt: signedAtMs,
            nonce,
          },
          auth: { token: this.token },
        },
      }));
      return;
    }

    if (frame.type === 'res') {
      if (frame.id === 'connect-1') {
        if (frame.ok) {
          this.connected = true;
          this.snapshot = frame.payload?.snapshot || frame.payload;
          // Persist device token if gateway issued one (pairing approved)
          const dt = frame.payload?.auth?.deviceToken;
          if (dt && this.storage) {
            this.storage.set('deviceToken', dt);
            this.log.info('Device token saved (pairing approved)');
          }
          this.log.info('Connected to OpenClaw gateway');
          this._emit('connection', { connected: true, snapshot: this.snapshot });
        } else {
          const errMsg = frame.error?.message || frame.error?.code || 'unknown';
          this.log.error(`Gateway connect rejected: ${errMsg}`);
          this.log.error(`Full error: ${JSON.stringify(frame.error)}`);
        }
        return;
      }
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          pending.reject(new Error(frame.error?.message || 'RPC error'));
        }
      }
    } else if (frame.type === 'event') {
      this._emit(frame.event, frame.payload);
    }
  }

  _emit(event, payload) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(payload); } catch (err) {
          this.log.error(`Event handler error [${event}]: ${err.message}`);
        }
      }
    }
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.log.info('Attempting reconnect...');
      this.connect();
    }, 5000);
  }
}

module.exports = { OpenClawClient };
