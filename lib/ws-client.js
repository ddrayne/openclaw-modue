// Minimal WebSocket client using Node.js builtins only (http + crypto)
// No npm dependencies — works in the Modue plugin sandbox

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PROTOCOL_VERSION = 3;

class OpenClawClient {
  constructor(url, token, log) {
    this.url = url;
    this.token = token;
    this.log = log;
    this.socket = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.seq = 0;
    this.connected = false;
    this.reconnectTimer = null;
    this.snapshot = null;
    this._buffer = Buffer.alloc(0);
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

      socket.on('data', (data) => this._onData(data));

      socket.on('close', () => {
        this.log.info('Socket closed');
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

  disconnect() {
    clearTimeout(this.reconnectTimer);
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
        // Ping — respond with pong
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a; // FIN + pong
        pong[1] = 0x00;
        this.socket?.write(pong);
      }
      // Ignore other opcodes (pong, continuation, binary)
    }
  }

  _handleFrame(frame) {
    // Wait for connect.challenge before sending connect request
    if (this._awaitingChallenge && frame.type === 'event' && frame.event === 'connect.challenge') {
      this._awaitingChallenge = false;
      this.log.info('Challenge received, sending connect request');
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
            version: '0.2.0',
            platform: 'darwin',
            mode: 'cli',
          },
          auth: { token: this.token },
        },
      }));
      return;
    }

    if (frame.type === 'res') {
      if (frame.id === 'connect-1' && frame.ok) {
        this.connected = true;
        this.snapshot = frame.payload?.snapshot || frame.payload;
        this.log.info('Connected to OpenClaw gateway');
        this._emit('connection', { connected: true, snapshot: this.snapshot });
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
