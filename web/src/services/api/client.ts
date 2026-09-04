/**
 * Backend API client — the only place the web/desktop frontend talks HTTP to
 * the backend. Base URL comes from VITE_API_BASE_URL (default: local dev).
 *
 * The backend speaks one error envelope — { "error": { code, message } } —
 * mapped here to a typed ApiClientError. Network failures (backend down)
 * are distinguished from HTTP errors via status 0.
 */

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Typed error mirroring the backend's JSON envelope. `status 0` = network failure. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000"
).replace(/\/+$/, "");

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = "GET", body, token } = options;
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiClientError(0, "network/unavailable", `Cannot reach the backend at ${API_BASE_URL}. Is it running?`);
  }

  if (!response.ok) {
    let code = "unknown/error";
    let message = `Request failed with status ${response.status}.`;
    try {
      const data = (await response.json()) as Partial<ApiErrorBody>;
      if (data?.error) {
        code = data.error.code ?? code;
        message = data.error.message ?? message;
      }
    } catch {
      // Non-JSON error body — keep the generic defaults..
    }
    throw new ApiClientError(response.status, code, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}