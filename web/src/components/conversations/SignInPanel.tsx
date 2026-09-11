import { useState, type FormEvent } from "react";
import { Sparkles } from "../Icons";
import { useSession } from "../../services/useSession";
import SignUpPanel from "./SignUpPanel";

/**
 * Sign-in panel used when the desktop UI has no active in-memory session. It
 * reuses the existing backend login abstraction via the centralized session
 * store — the bearer token never enters component state or the URL. A small
 * "Create account" toggle reveals the sign-up panel for new users.
 */
export default function SignInPanel() {
  const { login } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (mode === "signup") {
    return <SignUpPanel onSwitchToSignIn={() => setMode("signin")} />;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="w-10 h-10 rounded-xl bg-ai-bg flex items-center justify-center mb-3">
          <Sparkles size={18} className="text-ai-text" />
        </div>
        <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
          Sign in to view your conversations
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your AI conversation history is private and tied to your account.
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-transparent outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all placeholder:text-muted-foreground"
          />
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-transparent outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all placeholder:text-muted-foreground"
          />
          {error !== null && <p className="text-xs text-rose-500">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !email.trim() || !password}
            className="w-full text-sm px-3 py-2 rounded-xl bg-accent text-white hover:bg-indigo-600 disabled:opacity-40 transition-colors"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-xs text-center">
          <span className="text-muted-foreground">Don&apos;t have an account?</span>{" "}
          <button type="button" onClick={() => setMode("signup")} className="text-accent hover:underline">
            Create one
          </button>
        </p>
      </div>
    </div>
  );
}