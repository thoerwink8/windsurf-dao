import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export class AcpRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'AcpRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** ACP uses newline-delimited JSON-RPC, not LSP Content-Length framing.
 * Owns the transport only; the caller owns process lifetime and permissions.
 * onRequest may wait for human input without blocking notifications/responses.
 */
export class AcpClient extends EventEmitter {
  constructor({ readable, writable, onRequest, onNotification, onMessage, maxFrameBytes = 8 * 1024 * 1024 }) {
    super();
    this.readable = readable;
    this.writable = writable;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onMessage = onMessage;
    this.maxFrameBytes = maxFrameBytes;
    this.pending = new Map();
    this.incoming = new Set();
    this.serial = 0;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.writes = Promise.resolve();
    this.closed = false;
    this.dataHandler = chunk => {
      try { this.consume(this.decoder.write(chunk)); }
      catch (error) { this.close(error); }
    };
    this.endHandler = () => this.close(new AcpRpcError('transport_closed', 'ACP stdout closed'));
    this.errorHandler = () => this.close(new AcpRpcError('transport_error', 'ACP transport failed'));
    readable.on('data', this.dataHandler);
    readable.on('end', this.endHandler);
    readable.on('error', this.errorHandler);
    writable.on('error', this.errorHandler);
  }

  consume(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxFrameBytes) throw new AcpRpcError('frame_too_large', 'ACP frame exceeds limit');
      let msg;
      try { msg = JSON.parse(line); }
      catch { throw new AcpRpcError('invalid_json', 'ACP sent malformed JSON'); }
      this.receive(msg);
      if (this.closed) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) throw new AcpRpcError('frame_too_large', 'ACP frame exceeds limit');
  }

  receive(msg) {
    if (!msg || Array.isArray(msg) || msg.jsonrpc !== '2.0') throw new AcpRpcError('invalid_rpc', 'Invalid ACP JSON-RPC envelope');
    this.onMessage?.(msg);
    if (typeof msg.method === 'string') {
      if (!Object.hasOwn(msg, 'id')) {
        Promise.resolve().then(() => this.onNotification?.(msg.method, msg.params)).catch(error => this.close(error));
        return;
      }
      if ((typeof msg.id !== 'string' && typeof msg.id !== 'number') || this.incoming.has(msg.id)) {
        throw new AcpRpcError('invalid_rpc', 'Invalid or duplicate ACP request ID');
      }
      this.incoming.add(msg.id);
      Promise.resolve().then(() => {
        if (!this.onRequest) throw new AcpRpcError(-32601, 'Unsupported ACP request');
        return this.onRequest(msg.method, msg.params, msg.id);
      }).then(
        result => this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }),
        error => this.send({ jsonrpc: '2.0', id: msg.id, error: {
          code: Number.isInteger(error.code) ? error.code : -32603,
          // Do not put arbitrary exception messages (which may contain credentials) on the wire.
          message: Number.isInteger(error.code) ? error.message : 'ACP client request failed',
        } }),
      ).catch(error => this.close(error)).finally(() => this.incoming.delete(msg.id));
      return;
    }
    if (!Object.hasOwn(msg, 'id') || (Object.hasOwn(msg, 'result') === Object.hasOwn(msg, 'error'))) {
      throw new AcpRpcError('invalid_rpc', 'Invalid ACP response');
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return; // An expired response cannot satisfy another request.
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new AcpRpcError(msg.error.code, msg.error.message || 'ACP request rejected', msg.error.data));
    else pending.resolve(msg.result);
  }

  send(msg) {
    const line = JSON.stringify(msg) + '\n';
    const next = this.writes.then(() => new Promise((resolve, reject) => {
      if (this.closed) { reject(new AcpRpcError('transport_closed', 'ACP transport closed')); return; }
      this.writable.write(line, error => error ? reject(new AcpRpcError('transport_error', 'ACP write failed')) : resolve());
    }));
    this.writes = next.catch(() => {});
    return next;
  }

  request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new AcpRpcError('transport_closed', 'ACP transport closed')); return; }
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpRpcError('rpc_timeout', `ACP ${method} timed out`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params }).catch(error => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method, params = {}) { return this.send({ jsonrpc: '2.0', method, params }); }

  close(error = new AcpRpcError('transport_closed', 'ACP transport closed')) {
    if (this.closed) return;
    this.closed = true;
    this.readable.off('data', this.dataHandler);
    this.readable.off('end', this.endHandler);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    // Keep error listeners until stream destruction: late EPIPE must not crash the supervisor.
    this.emit('closed', error);
  }
}
