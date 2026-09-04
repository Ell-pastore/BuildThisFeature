/**
 * Typed API surface for the Smart File Manager backend.
 *
 * Today: health (public) + auth (register/login/me — the endpoints shipped
 * in Phase 7). File/cloud endpoints arrive with later phases.
 */
import { apiRequest } from "./client";

export { ApiClientError, API_BASE_URL, apiRequest } from "./client";
export type { ApiErrorBody, ApiRequestOptions } from "./client";

export interface SafeUserRemote {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt?: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  time: string;
  components: Record<string, string>;
}

export function fetchHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>("/api/health");
}

export const authApi = {
  register(input: { email: string; displayName: string; password: string }): Promise<{ user: SafeUserRemote }> {
    return apiRequest("/api/auth/register", { method: "POST", body: input });
  },
  login(input: { email: string; password: string }): Promise<{ user: SafeUserRemote; token: string }> {
    return apiRequest("/api/auth/login", { method: "POST", body: input });
  },
  me(token: string): Promise<{ user: SafeUserRemote }> {
    return apiRequest("/api/auth/me", { token });
  },
};