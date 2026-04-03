// Uses Node.js 22+ built-in WebSocket (no npm dependencies needed)

const PROTOCOL_VERSION = 3;

class OpenClawClient {
  constructor(url, token, log) {
    this.url = url;
    this.token = token;
    this.log = log;
    this.ws = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.seq = 0;
    this.connected = false;
    this.reconnectTimer = null;
    this.snapshot = null;
  }

  connect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    this.log.info(`Connecting to OpenClaw at ${this.url}`);
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.log.info('WebSocket open, sending handshake');
      this._send({
        type: 'req',
        id: 'connect-1',
        method: 'connect',
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: 'modue-plugin',
            displayName: 'Modue Control Surface',
            version: '0.1.0',
            platform: 'darwin',
            mode: 'node',
          },
          auth: { token: this.token },
        },
      });
    };

    this.ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      } catch {
        this.log.warn('Failed to parse frame');
        return;
      }
      this._handleFrame(frame);
    };

    this.ws.onclose = (event) => {
      this.log.warn(`WebSocket closed: ${event.code} ${event.reason}`);
      this.connected = false;
      this._emit('connection', { connected: false });
      this._scheduleReconnect();
    };

    this.ws.onerror = (event) => {
      this.log.error(`WebSocket error: ${event.message || 'connection failed'}`);
    };
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = `${method}-${++this.seq}`;
      this._send({ type: 'req', id, method, params });
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

  _send(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  // Alias for compat — native WebSocket uses OPEN constant on the class
  static get OPEN() { return WebSocket.OPEN; }

  _handleFrame(frame) {
    if (frame.type === 'res') {
      // Handle hello-ok from connect
      if (frame.id === 'connect-1' && frame.ok) {
        this.connected = true;
        this.snapshot = frame.payload?.snapshot || frame.payload;
        this.log.info('Connected to OpenClaw gateway');
        this._emit('connection', { connected: true, snapshot: this.snapshot });
        return;
      }
      // Handle RPC responses
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
        try {
          handler(payload);
        } catch (err) {
          this.log.error(`Event handler error [${event}]: ${err.message}`);
        }
      }
    }
    // Also emit to wildcard listeners
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const handler of wildcard) {
        try {
          handler(event, payload);
        } catch (err) {
          this.log.error(`Wildcard handler error: ${err.message}`);
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
