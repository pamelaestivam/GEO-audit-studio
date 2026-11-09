import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

declare global {
  interface Window {
    google?: any;
  }
}

/** Google's own sign-in script. It draws the button (in a frame of its own) and hands back a signed token. */
export const GSI_SRC = 'https://accounts.google.com/gsi/client';
const LOAD_TIMEOUT_MS = 12_000;

let loading: Promise<void> | null = null;

/** Load Google's script once. Rejects (and may be tried again) if it is blocked, offline, or too slow. */
export function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    const fail = (why: string) => {
      window.clearTimeout(timer);
      script.remove();
      loading = null;
      reject(new Error(why));
    };
    const timer = window.setTimeout(() => fail('timeout'), LOAD_TIMEOUT_MS);
    script.onload = () => {
      window.clearTimeout(timer);
      if (window.google?.accounts?.id) resolve();
      else fail('no google object');
    };
    script.onerror = () => fail('blocked or offline');
    document.head.appendChild(script);
  });
  return loading;
}

interface GoogleSignInButtonProps {
  clientId: string;
  /** Called with Google's signed ID token. The server checks it; nothing here trusts it. */
  onCredential: (credential: string) => void;
  /** True while the token is being checked by the server: the button is replaced by a line saying so. */
  busy?: boolean;
}

/**
 * "Continue with Google". Google draws the button, so the look (and the account chooser behind it) is Google's. If its
 * script cannot be loaded - an ad blocker, a network rule, no connection - that is said in a sentence with a way to
 * try again, never left as an empty space where a button should be.
 */
export const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({ clientId, onCredential, busy = false }) => {
  const holder = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    loadGoogleIdentity()
      .then(() => {
        if (cancelled || !holder.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response: { credential?: string }) => {
            if (response?.credential) callback.current(response.credential);
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        // Google accepts a width of 200 to 400 pixels; fit the space there is. The holder itself is hidden until the
        // button is drawn (so it measures 0), so the space is that of the box it sits in.
        const space = holder.current.parentElement?.clientWidth || 0;
        const width = Math.max(200, Math.min(400, Math.floor(space || 320)));
        holder.current.innerHTML = '';
        window.google.accounts.id.renderButton(holder.current, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width,
        });
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div data-testid="google-signin">
      <div ref={holder} className={status === 'ready' && !busy ? 'flex justify-center min-h-[44px]' : 'hidden'} />

      {status === 'loading' && (
        <div
          role="status"
          className="h-11 rounded-xl bg-slate-800/60 border border-slate-700/80 flex items-center justify-center gap-2 text-xs text-slate-400"
        >
          <span className="h-3.5 w-3.5 border-2 border-slate-600 border-t-slate-300 rounded-full animate-spin" />
          Loading Google sign-in...
        </div>
      )}

      {status === 'ready' && busy && (
        <div
          role="status"
          className="h-11 rounded-xl bg-slate-800/60 border border-slate-700/80 flex items-center justify-center gap-2 text-xs text-slate-200"
        >
          <span className="h-3.5 w-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
          Signing in with Google...
        </div>
      )}

      {status === 'failed' && (
        <div role="alert" className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-medium flex items-start gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
          <div className="flex-1">
            <span>Google sign-in could not be loaded. An ad blocker, a network setting or a lost connection can cause this.</span>{' '}
            <button type="button" onClick={retry} className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-white">
              <RefreshCw className="h-3 w-3" />
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
