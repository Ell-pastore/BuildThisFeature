import { useState, type FormEvent } from "react";
import { Sparkles } from "../Icons";
import { useSession } from "../../services/useSession";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

interface SignUpPanelProps {
  onSwitchToSignIn: () => void;
}

/**
 * Sign-up panel used while the desktop UI has no active in-memory session. It
 * registers through the existing backend register endpoint via the centralized
 * session store, which then signs the new account in immediately. Client-side
 * validation mirrors the backend requirements (email shape, display name,
 * 8+ char password, matching confirmation).
 */
export default function SignUpPanel({ onSwitchToSignIn }: SignUpPanelProps) {
  const { register } = useSession();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (displayName.trim().length === 0) {
      setError("Please enter your name.");
      return;
    }
    if (!EMAIL_PATTERN.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await register(email.trim(), displayName.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create your account.");
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
          Create your account
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your AI conversation history is private and tied to your account.
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <input
            type="text"
            required
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Name"
            className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-transparent outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all placeholder:text-muted-foreground"
          />
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-transparent outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all placeholder:text-muted-foreground"
          />
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-transparent outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all placeholder:text-muted-foreground"
          />
          {error !== null && <p className="text-xs text-rose-500">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !displayName.trim() || !email.trim() || !password || !confirmPassword}
            className="w-full text-sm px-3 py-2 rounded-xl bg-accent text-white hover:bg-indigo-600 disabled:opacity-40 transition-colors"
          >
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="mt-4 text-xs text-center">
          <span className="text-muted-foreground">Already have an account?</span>{" "}
          <button type="button" onClick={onSwitchToSignIn} className="text-accent hover:underline">
            Sign in
          </button>
        </p>
      </div>
    </div>
  );
}