import { IncomingMessage, ServerResponse, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

type ExpressHandler = (request: IncomingMessage, response: ServerResponse) => unknown;

export type InProcessRequestOptions = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  deferBody?: boolean;
  remoteAddress?: string;
  omitHost?: boolean;
};

export type InProcessResponse<T = unknown> = {
  status: number;
  headers: OutgoingHttpHeaders;
  rawBody: Buffer;
  text: string;
  body: T;
};

class MemorySocket extends Duplex {
  readonly output: Buffer[] = [];

  constructor(remoteAddress: string) {
    super();
    Object.defineProperty(this, 'remoteAddress', { configurable: true, value: remoteAddress });
    Object.defineProperty(this, 'remotePort', { configurable: true, value: 12345 });
  }

  _read(): void {}

  _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
    callback();
  }
}

function normaliseHeaders(headers: Record<string, string>): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function decodeChunkedBody(input: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < input.length) {
    const lineEnd = input.indexOf('\r\n', offset);
    if (lineEnd < 0) throw new Error('Invalid chunked response: missing chunk length delimiter.');
    const size = Number.parseInt(input.subarray(offset, lineEnd).toString('ascii').split(';')[0], 16);
    if (!Number.isFinite(size)) throw new Error('Invalid chunked response: malformed chunk length.');
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(input.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function responseBodyFromWire(socket: MemorySocket, response: ServerResponse): Buffer {
  const wire = Buffer.concat(socket.output);
  const delimiter = wire.indexOf('\r\n\r\n');
  if (delimiter < 0) return Buffer.alloc(0);
  const encodedBody = wire.subarray(delimiter + 4);
  return String(response.getHeader('transfer-encoding')).toLowerCase() === 'chunked'
    ? decodeChunkedBody(encodedBody)
    : encodedBody;
}

export function beginInProcessRequest<T = unknown>(
  app: ExpressHandler,
  options: InProcessRequestOptions
): {
  response: Promise<InProcessResponse<T>>;
  sendBody: () => void;
} {
  const socket = new MemorySocket(options.remoteAddress ?? '198.51.100.7');
  // IncomingMessage/ServerResponse type their transport as net.Socket, while
  // only the Duplex contract is exercised by this no-network harness.
  const transport = socket as unknown as Socket;
  const request = new IncomingMessage(transport);
  const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body ?? '');
  const headers = normaliseHeaders({
    ...(!options.omitHost ? { host: '127.0.0.1:4315' } : {}),
    connection: 'close',
    ...(body.length > 0 ? { 'content-length': String(body.length) } : {}),
    ...options.headers
  });
  request.method = (options.method ?? 'GET').toUpperCase();
  request.url = options.path;
  request.headers = headers;
  request.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, String(value)]);

  const serverResponse = new ServerResponse(request);
  serverResponse.shouldKeepAlive = false;
  serverResponse.assignSocket(transport);

  let bodySent = false;
  const sendBody = () => {
    if (bodySent) return;
    bodySent = true;
    if (body.length > 0) request.push(body);
    // IncomingMessage normally gets this flag from Node's HTTP parser. Without it,
    // ending the synthetic readable emits a false `aborted` event and Multer
    // correctly rejects the request before Busboy can finish parsing it.
    request.complete = true;
    request.push(null);
  };

  const response = new Promise<InProcessResponse<T>>((resolve, reject) => {
    serverResponse.once('finish', () => {
      setImmediate(() => {
        try {
          const rawBody = responseBodyFromWire(socket, serverResponse);
          const text = rawBody.toString('utf8');
          const contentType = String(serverResponse.getHeader('content-type') ?? '');
          const parsed = contentType.includes('application/json') && text ? JSON.parse(text) : text;
          resolve({
            status: serverResponse.statusCode,
            headers: serverResponse.getHeaders(),
            rawBody,
            text,
            body: parsed as T
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    serverResponse.once('error', reject);
    socket.once('error', reject);
    try {
      app(request, serverResponse);
    } catch (error) {
      reject(error);
    }
  });

  if (!options.deferBody) sendBody();
  return { response, sendBody };
}

export function inProcessRequest<T = unknown>(app: ExpressHandler, options: InProcessRequestOptions): Promise<InProcessResponse<T>> {
  return beginInProcessRequest<T>(app, options).response;
}

export function jsonRequest<T = unknown>(
  app: ExpressHandler,
  method: string,
  requestPath: string,
  value: unknown,
  headers: Record<string, string> = {}
): Promise<InProcessResponse<T>> {
  return inProcessRequest<T>(app, {
    method,
    path: requestPath,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value)
  });
}

export function createMultipartBody(input: {
  fields?: Record<string, string>;
  file?: { fieldName?: string; fileName: string; contentType: string; data: Buffer };
}): { body: Buffer; contentType: string } {
  const boundary = 'page2knowledge-in-process-boundary';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (input.file) {
    const fieldName = input.file.fieldName ?? 'file';
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${input.file.fileName}"\r\n`
      + `Content-Type: ${input.file.contentType}\r\n\r\n`
    ));
    chunks.push(input.file.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
