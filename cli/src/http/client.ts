/**
 * HTTP client for making requests to the walt.id Enterprise API.
 *
 * Features:
 * - Bearer token authentication
 * - Request/response logging
 * - JSON and text content type support
 * - Error handling with response data
 * - Opt-in private logging, bounded requests and strict origin/redirect handling
 */

// ============================================================================
// Types
// ============================================================================

/** HTTP response wrapper */
export interface HttpResponse<T = any> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

/** Logged HTTP request/response pair */
export interface HttpLogEntry {
  request: {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    body?: any;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    data: any;
  };
  timestamp: string;
}

export interface HttpClientOptions {
  /** Sensitive commands must not retain payloads, headers or resource identifiers. */
  logging?: 'full' | 'none';
  /** Reject redirects and cross-origin paths; the caller validates the base URL. */
  strictTransport?: boolean;
  timeoutMs?: number;
}

export interface HttpRequestOptions {
  /** Omit bearer authentication for public endpoints and denial controls. */
  auth?: boolean;
  /** Expected non-success status codes; all other failures still throw. */
  allow?: readonly number[];
  contentType?: string;
  raw?: boolean;
}

// ============================================================================
// HTTP Client
// ============================================================================

/**
 * HTTP client with authentication and logging support.
 *
 * @example
 * ```typescript
 * const client = new HttpClient('http://api.example.com');
 * client.setToken('my-bearer-token');
 * const response = await client.get('/v1/users');
 * ```
 */
export class HttpClient {
  private baseUrl: string;
  private token: string | null = null;
  private httpLog: HttpLogEntry[] = [];

  constructor(baseUrl: string, private options: HttpClientOptions = {}) {
    this.baseUrl = baseUrl;
  }

  /** Set bearer token for authentication */
  setToken(token: string): void {
    this.token = token;
  }

  /** Get the current bearer token */
  getToken(): string | null {
    return this.token;
  }

  /** Get all logged HTTP requests/responses */
  getHttpLog(): HttpLogEntry[] {
    return this.httpLog;
  }

  /** Clear the HTTP log */
  clearHttpLog(): void {
    this.httpLog = [];
  }

  /** Get the base URL */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Make an HTTP request.
   * Request options support anonymous calls and explicit negative controls.
   */
  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    requestOptions: HttpRequestOptions = {}
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    if (this.options.strictTransport && (
      !path.startsWith('/') || path.startsWith('//') ||
      new URL(path, this.baseUrl).origin !== new URL(this.baseUrl).origin
    )) {
      throw new Error('API path must remain on the configured origin');
    }
    const contentType = requestOptions.contentType ?? 'application/json';
    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    if (this.token && requestOptions.auth !== false) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const options: RequestInit = {
      method,
      headers,
    };

    if (this.options.strictTransport) options.redirect = 'error';
    if (this.options.timeoutMs !== undefined) options.signal = AbortSignal.timeout(this.options.timeoutMs);

    if (body !== undefined) {
      if (requestOptions.raw) {
        options.body = body as RequestInit['body'];
      } else if (contentType === 'application/json') {
        options.body = JSON.stringify(body);
      } else {
        options.body = body as RequestInit['body'];
      }
    }

    const response = await fetch(url, options);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // No-content responses may still carry an application/json Content-Type.
    const text = await response.text();
    let data: T = text as T;
    if (text && response.headers.get('content-type')?.includes('application/json')) {
      data = JSON.parse(text) as T;
    }

    if (this.options.logging !== 'none') {
      this.httpLog.push({
        request: {
          method,
          url,
          headers: { ...headers, Authorization: headers.Authorization ? '[REDACTED]' : undefined },
          body,
        },
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          data,
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (!response.ok && !requestOptions.allow?.includes(response.status)) {
      const message = this.options.logging === 'none'
        ? `HTTP ${response.status}`
        : `HTTP ${response.status}: ${response.statusText}`;
      const error = new Error(message) as Error & {
        status: number;
        response?: { data: T; headers: Record<string, string> };
      };
      error.status = response.status;
      if (this.options.logging !== 'none') error.response = { data, headers: responseHeaders };
      throw error;
    }

    return {
      status: response.status,
      data,
      headers: responseHeaders,
    };
  }

  /** GET request */
  async get<T = any>(path: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  /** POST request with JSON body */
  async post<T = any>(path: string, body?: any, contentType: string = 'application/json'): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, { contentType });
  }

  /** POST request with raw string body (no JSON.stringify) */
  async postRaw<T = any>(path: string, body: string, contentType: string = 'application/json'): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, { contentType, raw: true });
  }

  /** PATCH request */
  async patch<T = any>(path: string, body?: any): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', path, body);
  }

  /** PUT request */
  async put<T = any>(path: string, body?: any): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', path, body);
  }

  /** DELETE request */
  async delete<T = any>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path);
  }
}
