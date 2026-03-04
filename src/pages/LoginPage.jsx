import { useState } from "react";

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    if (!password) {
      setError("Password is required.");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await onLogin?.({ email: email.trim(), password });
      if (result && result.ok === false) {
        setError(result.error || "Login failed.");
      }
    } catch {
      setError("Login failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="authPage">
      <div className="authCard card" aria-label="Login">
        <div className="cardHeader">
          <div className="cardTitle">Login</div>
          <div className="cardSubtitle">Sign in to continue</div>
        </div>

        <form className="authBody" onSubmit={handleSubmit}>
          <label className="field">
            <div className="fieldLabel">Email</div>
            <input
              className="textInput"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>

          <label className="field">
            <div className="fieldLabel">Password</div>
            <input
              className="textInput"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="Password"
            />
          </label>

          {error ? <div className="authError">{error}</div> : null}

          <div className="authActions">
            <button className="btn btnPrimary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Logging in..." : "Login"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
