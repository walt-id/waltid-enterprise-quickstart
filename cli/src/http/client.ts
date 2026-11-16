/** Shared HTTP transport for setup commands and credential flows. */
export interface HttpResponse<T = any> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export interface HttpLogEntry {
  request: { method: string; url: string; headers: Record<string, string | undefined>; body?: any };
  response: { status: number; statusText: string; headers: Record<string, string>; data: any };
  timestamp: string;
}

export interface HttpClientOptions {
  /** Sensitive flows must not retain HTTP payloads, headers or resource identifiers. */
  logging?: 'full' | 'none';
  /** Refuse cross-origin paths and redirects; HTTPS is checked by scenario configuration. */
  strictTransport?: boolean;
  timeoutMs?: number;
}

export interface HttpRequestOptions {
  auth?: boolean;
  allow?: readonly number[];
  expectedError?: string;
  contentType?: string;
  raw?: boolean;
}

export class HttpClient {
  private token: string | null = null;
  private httpLog: HttpLogEntry[] = [];

  constructor(private baseUrl: string, private options: HttpClientOptions = {}) {}

  setToken(token: string): void { this.token = token; }
  getToken(): string | null { return this.token; }
  getHttpLog(): HttpLogEntry[] { return this.httpLog; }
  clearHttpLog(): void { this.httpLog = []; }
  getBaseUrl(): string { return this.baseUrl; }

  async request<T = any>(
    method: string, path: string, body?: unknown, options: HttpRequestOptions = {}
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    if (this.options.strictTransport && (
      !path.startsWith('/') || path.startsWith('//') ||
      new URL(path, this.baseUrl).origin !== new URL(this.baseUrl).origin
    )) throw new Error('API path must remain on the configured origin');

    const headers: Record<string, string> = { 'Content-Type': options.contentType ?? 'application/json' };
    if (this.token && options.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    const request: RequestInit = { method, headers };
    if (this.options.strictTransport) request.redirect = 'error';
    if (this.options.timeoutMs !== undefined) request.signal = AbortSignal.timeout(this.options.timeoutMs);
    if (body !== undefined) request.body = options.raw || headers['Content-Type'] !== 'application/json'
      ? body as string : JSON.stringify(body);

    const response = await fetch(url, request);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    const text = await response.text();
    let data: T = text as T;
    if (text && response.headers.get('content-type')?.includes('application/json')) data = JSON.parse(text) as T;

    if (this.options.logging !== 'none') this.httpLog.push({
      request: { method, url, headers: { ...headers, Authorization: headers.Authorization ? '[REDACTED]' : undefined }, body },
      response: { status: response.status, statusText: response.statusText, headers: responseHeaders, data },
      timestamp: new Date().toISOString(),
    });

    if (options.expectedError && (response.ok || !text.includes(options.expectedError))) {
      throw new Error('API did not return the expected rejection');
    }
    if (!response.ok && !options.allow?.includes(response.status)) {
      const error = new Error(`HTTP ${response.status}`) as Error & {
        status: number; response?: { data: T; headers: Record<string, string> };
      };
      error.status = response.status;
      if (this.options.logging !== 'none') error.response = { data, headers: responseHeaders };
      throw error;
    }
    return { status: response.status, data, headers: responseHeaders };
  }

  get<T = any>(path: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }
  post<T = any>(path: string, body?: unknown, contentType = 'application/json'): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, { contentType });
  }
  postRaw<T = any>(path: string, body: string, contentType = 'application/json'): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, { contentType, raw: true });
  }
  patch<T = any>(path: string, body?: unknown): Promise<HttpResponse<T>> { return this.request<T>('PATCH', path, body); }
  put<T = any>(path: string, body?: unknown): Promise<HttpResponse<T>> { return this.request<T>('PUT', path, body); }
  delete<T = any>(path: string): Promise<HttpResponse<T>> { return this.request<T>('DELETE', path); }
}
