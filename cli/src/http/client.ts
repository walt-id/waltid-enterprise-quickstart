/**
 * HTTP client for making requests to the walt.id Enterprise API.
 * 
 * Features:
 * - Bearer token authentication
 * - Request/response logging
 * - JSON and text content type support
 * - Error handling with response data
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

  constructor(baseUrl: string) {
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
   * @internal
   */
  private async request<T>(
    method: string,
    path: string,
    body?: any,
    contentType: string = 'application/json',
    skipStringify: boolean = false
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const requestLog = {
      method,
      url,
      headers: { ...headers, Authorization: headers.Authorization ? '[REDACTED]' : undefined },
      body,
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      if (skipStringify) {
        options.body = body;
      } else if (contentType === 'application/json') {
        options.body = JSON.stringify(body);
      } else {
        options.body = body;
      }
    }

    const response = await fetch(url, options);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let data: T;
    const responseContentType = response.headers.get('content-type');
    if (responseContentType?.includes('application/json')) {
      data = await response.json() as T;
    } else {
      data = await response.text() as unknown as T;
    }

    const responseLog = {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data,
    };

    this.httpLog.push({
      request: requestLog,
      response: responseLog,
      timestamp: new Date().toISOString(),
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as any;
      error.status = response.status;
      error.response = { data, headers: responseHeaders };
      throw error;
    }

    return {
      status: response.status,
      data,
      headers: responseHeaders,
    };
  }

  /** GET request */
  async get<T = any>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path);
  }

  /** POST request with JSON body */
  async post<T = any>(path: string, body?: any, contentType: string = 'application/json'): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, contentType);
  }

  /** POST request with raw string body (no JSON.stringify) */
  async postRaw<T = any>(path: string, body: string, contentType: string = 'application/json'): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, contentType, true);
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
