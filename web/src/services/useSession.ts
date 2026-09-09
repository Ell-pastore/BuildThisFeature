import { useSyncExternalStore } from "react";
import {
  getSessionSnapshot,
  login as sessionLogin,
  logout as sessionLogout,
  subscribeSession,
  type SessionState,
} from "./session";

/**
 * Reactive binding over the centralized session store. Components receive the
 * resolved session state (user + whether authenticated) and the login/logout
 * actions — never the raw bearer token.
 */
export interface SessionBinding {
  user: SessionState["user"];
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<NonNullable<SessionState["user"]>>;
  logout: () => Promise<void>;
}

export function useSession(): SessionBinding {
  const state = useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot);
  return {
    user: state.user,
    isAuthenticated: state.user !== null && state.token !== null,
    login: sessionLogin,
    logout: sessionLogout,
  };
}