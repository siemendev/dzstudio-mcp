/** Request and response transport of dzcollab 1: POST with a JSON body, answer `dzcollab 1\n` + one JSON object. */

export type Json = Record<string, any>;

export const PROTOCOL = '1.0';
const MARKER = 'dzcollab 1\n';

/** A response with `ok: false`. */
export class CollabError extends Error {
  constructor(
    readonly code: string,
    readonly error: Json,
  ) {
    super(error.message ? `${code}: ${error.message}` : code);
  }
}

/** No usable response: network error, timeout, or a body without the header line or with broken JSON. */
export class UnreachableError extends Error {}

export interface CallOptions {
  timeoutMs?: number;
  method?: 'GET' | 'POST';
  signal?: AbortSignal;
}

export interface Transport {
  /** Sends one request and returns the parsed response object (with `ok`), or throws UnreachableError. */
  call(endpoint: string, body: Json | undefined, opts?: CallOptions): Promise<Json>;
}

export function parseResponse(text: string): Json {
  if (!text.startsWith(MARKER)) throw new UnreachableError('Server not reachable (no dzcollab header line)');
  let body: unknown;
  try {
    body = JSON.parse(text.slice(MARKER.length));
  } catch {
    throw new UnreachableError('Server not reachable (incomplete response)');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Json).ok !== 'boolean') {
    throw new UnreachableError('Server not reachable (not a dzcollab response)');
  }
  return body as Json;
}

export class HttpTransport implements Transport {
  readonly base: string;

  constructor(base: string) {
    this.base = base.endsWith('/') ? base : base + '/';
  }

  async call(endpoint: string, body: Json | undefined, opts: CallOptions = {}): Promise<Json> {
    const method = opts.method ?? 'POST';
    let text: string;
    try {
      const res = await fetch(this.base + endpoint, {
        method,
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 10_000)])
          : AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        redirect: 'manual',
      });
      text = await res.text();
    } catch (e) {
      throw new UnreachableError(`Server not reachable (${(e as Error).message})`);
    }
    return parseResponse(text);
  }
}

/** Throws CollabError for a response with `ok: false`. */
export function ensureOk(res: Json): Json {
  if (res.ok !== true) {
    const error = (res.error ?? {}) as Json;
    throw new CollabError(typeof error.code === 'string' ? error.code : 'internal', error);
  }
  return res;
}
