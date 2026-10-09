import React, { useState } from 'react';
import { Sparkles, Eye, EyeOff, Lock, Mail, ArrowRight, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { User } from '../types';
import { apiFetch } from '../apiClient';
import { useAuditStatus } from '../useQuotaStatus';

export interface Session {
  user: User;
  token: string;
  expiresAt: number;
}

interface AuthPageProps {
  onLoginSuccess: (session: Session) => void;
  /** Why the person is back here (e.g. "Your session has expired."), when they were signed out. */
  notice?: string | null;
}

/**
 * Early access sign-in: an email and the access code the operator gave you.
 *
 * It used to catch every failure - wrong password, server down - and sign the
 * person in anyway as a locally invented user. A failed sign-in is now a
 * failed sign-in, and the server's own sentence is what is shown.
 */
export const AuthPage: React.FC<AuthPageProps> = ({ onLoginSuccess, notice }) => {
  const [email, setEmail] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { auth } = useAuditStatus();

  const unconfigured = auth?.mode === 'unconfigured';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.includes('@')) {
      setError('Enter the email address you were invited with.');
      return;
    }
    if (!accessCode.trim()) {
      setError('Enter your access code.');
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, accessCode }),
        // A wrong code is an answer, not a network failure: never retry it.
        retries: 0,
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok && data.user && data.token) {
        onLoginSuccess({ user: data.user, token: data.token, expiresAt: data.expiresAt });
      } else {
        setError(data.error || 'Sign-in did not succeed. Please try again.');
      }
    } catch (err: any) {
      setError(err?.message || 'Could not sign in. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4 sm:p-6 lg:p-8 font-sans relative overflow-hidden">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-80 h-80 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-4xl w-full grid grid-cols-1 lg:grid-cols-12 bg-slate-900/90 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden relative z-10 backdrop-blur-xl">
        <div className="lg:col-span-5 bg-gradient-to-br from-indigo-950/80 via-slate-900 to-slate-950 p-6 sm:p-8 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-800">
          <div>
            <div className="flex items-center gap-3 mb-8">
              <div className="p-2.5 rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 flex items-center justify-center">
                <Sparkles className="h-6 w-6" />
              </div>
              <div>
                <span className="font-extrabold text-xl tracking-tight text-white flex items-center gap-1.5">
                  GEO <span className="text-indigo-400">Audit Studio</span>
                </span>
                <span className="block text-[10px] uppercase tracking-widest text-indigo-300 font-bold">Early access</span>
              </div>
            </div>

            <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight mb-3">
              Audit Brand Visibility in AI Search Engines
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed mb-6">
              Find out whether AI answer engines recommend your brand, who they recommend instead, and which sources
              they trust.
            </p>

            <div className="space-y-3.5 pt-2">
              {[
                'Live, web-grounded answers captured verbatim with their sources',
                'Share of voice measured against the vendors the engines name',
                'Suggested fixes tied to the gaps found in your audit',
                'Failures are reported as failures, never as zeros',
              ].map((text) => (
                <div key={text} className="flex items-start gap-2.5">
                  <div className="p-1 rounded bg-indigo-500/20 text-indigo-400 mt-0.5 shrink-0">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </div>
                  <span className="text-xs font-medium text-slate-200">{text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-800/80 text-[11px] text-slate-400 leading-relaxed">
            Access is by invitation. Your access code is checked on the server; sessions expire and end if your code is
            withdrawn.
          </div>
        </div>

        <div className="lg:col-span-7 p-6 sm:p-8 flex flex-col justify-between bg-slate-900/60">
          <div>
            <div className="mb-6">
              <h3 className="text-lg font-bold text-white">Sign in</h3>
              <p className="text-xs text-slate-400 mt-0.5">Enter the email you were invited with and your access code.</p>
            </div>

            {notice && !error && (
              <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-amber-200 text-xs font-medium">
                <Info className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
                <span>{notice}</span>
              </div>
            )}

            {/* The server cannot let anyone in until the operator configures it. Say so before they type. */}
            {unconfigured && (
              <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-2 text-rose-200 text-xs font-medium">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
                <span>{auth?.problem || 'Sign-in is not configured on this server.'}</span>
              </div>
            )}

            {auth?.mode === 'dev' && (
              <div className="mb-4 p-3 rounded-xl bg-slate-800/60 border border-slate-700 flex items-start gap-2 text-slate-300 text-xs">
                <Info className="h-4 w-4 shrink-0 text-slate-400 mt-0.5" />
                <span>
                  Development mode: this server has no access codes configured, so the code <code>dev-access</code> works.
                  This is never accepted in production.
                </span>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center gap-2 text-rose-300 text-xs font-medium"
              >
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="auth-email-input" className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                  Email <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                  <input
                    id="auth-email-input"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-950 text-white text-sm rounded-xl border border-slate-700/80 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition placeholder-slate-500 shadow-inner"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="auth-code-input" className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                  Access code <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                  <input
                    id="auth-code-input"
                    type={showCode ? 'text' : 'password'}
                    required
                    autoComplete="off"
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    placeholder="The code you were given"
                    className="w-full pl-10 pr-10 py-2.5 bg-slate-950 text-white text-sm rounded-xl border border-slate-700/80 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition placeholder-slate-500 shadow-inner"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCode(!showCode)}
                    aria-label={showCode ? 'Hide access code' : 'Show access code'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
                  >
                    {showCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading || unconfigured}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white font-bold text-xs tracking-wide shadow-lg shadow-indigo-600/30 transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                    Signing in...
                  </span>
                ) : (
                  <>
                    <span>Sign in</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800/80 text-center text-[11px] text-slate-500">
            Need access? Ask the person who runs this service for an invitation.
          </div>
        </div>
      </div>
    </div>
  );
};
