import React, { useState } from 'react';
import { ArrowLeft, Eye, EyeOff, MailCheck } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { useAuth } from '../context/AuthContext';
import { AppPage } from '../types/hosting';

interface AuthPageProps {
  mode: 'login' | 'register';
  onNavigate: (page: AppPage) => void;
}

export function AuthPage({ mode, onNavigate }: AuthPageProps) {
  const {
    user,
    authError,
    clearAuthError,
    loginWithGoogle,
    loginWithEmail,
    registerWithEmail,
    resendVerification,
    refreshAuthUser,
    logout,
  } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);

  const isRegister = mode === 'register';

  const handleGoogle = async () => {
    setSubmitting(true);
    const ok = await loginWithGoogle();
    setSubmitting(false);
    if (ok) {
      onNavigate('dashboard');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    if (isRegister) {
      const ok = await registerWithEmail(name || 'Developer', email, password);
      setSubmitting(false);
      if (ok) {
        setVerificationSent(true);
      }
    } else {
      const ok = await loginWithEmail(email, password);
      setSubmitting(false);
      if (ok) {
        onNavigate('dashboard');
      }
    }
  };

  // Show verification gate if signed in via email/password without verification
  if (user && !user.emailVerified) {
    return (
      <div className="min-h-screen bg-black text-zinc-100 flex items-center justify-center p-4">
        <div className="facon-glass rounded-2xl max-w-md w-full p-8 flex flex-col gap-5">
          <div className="flex items-center gap-3 text-[#00FFFF]">
            <MailCheck className="w-6 h-6" />
            <h1 className="font-display text-xl font-semibold text-white">
              Verify your email address
            </h1>
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed">
            A verification link was sent to <span className="text-white font-medium">{user.email}</span>.
            Click the link in your inbox, then refresh your verification status below.
          </p>
          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              onClick={async () => {
                await refreshAuthUser();
                onNavigate('dashboard');
              }}
              className="h-11 rounded-lg bg-[#00FFFF] text-black text-sm font-semibold hover:bg-[#66FFFF] transition-colors cursor-pointer"
            >
              I Have Verified My Email
            </button>
            <button
              type="button"
              onClick={async () => {
                await resendVerification();
                setVerificationSent(true);
              }}
              className="h-10 rounded-lg border border-white/15 text-sm text-zinc-300 hover:text-white transition-colors cursor-pointer"
            >
              {verificationSent ? 'Verification Email Resent' : 'Resend Verification Email'}
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="h-9 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              Use a different account
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col justify-between p-4 sm:p-8">
      <div className="max-w-[1320px] w-full mx-auto flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            clearAuthError();
            onNavigate('home');
          }}
          className="inline-flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Home</span>
        </button>
        <BrandMark />
      </div>

      <div className="max-w-md w-full mx-auto my-8">
        <div className="facon-glass rounded-2xl p-7 sm:p-8 flex flex-col gap-6">
          <div>
            <p className="text-xs font-medium text-[#00FFFF]">
              {isRegister ? 'Free Cloud Account' : 'Console Access'}
            </p>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-white mt-1">
              {isRegister ? 'Create your FACON HOST account' : 'Sign in to FACON HOST'}
            </h1>
            <p className="text-sm text-zinc-400 mt-1.5">
              {isRegister
                ? 'Includes 20 GB RAM, 500% CPU, 20 GB NVMe disk, 500 Mbps bandwidth, 5 backups, and up to 10 servers—free.'
                : 'Manage your running bots, live console streams, files, and snapshots.'}
            </p>
          </div>

          {authError && (
            <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-3.5 text-xs text-rose-200 leading-relaxed">
              {authError}
            </div>
          )}

          {/* Primary Instant Google Auth */}
          <button
            type="button"
            disabled={submitting}
            onClick={handleGoogle}
            className="h-11 px-4 rounded-lg bg-[#00FFFF] text-black text-sm font-semibold inline-flex items-center justify-center gap-2.5 hover:bg-[#66FFFF] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27c3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10c5.35 0 9.25-3.67 9.25-9.09c0-1.15-.15-1.81-.15-1.81Z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-[11px] text-zinc-500">or with email</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {isRegister && (
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Developer Name
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Alex Mercer"
                  className="w-full h-11 px-3.5 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#00FFFF]/60"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="developer@domain.com"
                className="w-full h-11 px-3.5 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#00FFFF]/60"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full h-11 pl-3.5 pr-11 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#00FFFF]/60"
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 h-8 w-8 inline-flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer"
                  aria-label={showPass ? 'Hide password' : 'Show password'}
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="h-11 rounded-lg border border-white/15 bg-white/[0.04] text-white text-sm font-medium hover:border-[#00FFFF]/50 hover:text-[#00FFFF] disabled:opacity-50 transition-colors cursor-pointer"
            >
              {submitting ? 'Authenticating...' : isRegister ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <p className="text-xs text-center text-zinc-400">
            {isRegister ? 'Already have an account?' : "Don't have an account yet?"}{' '}
            <button
              type="button"
              onClick={() => {
                clearAuthError();
                onNavigate(isRegister ? 'login' : 'register');
              }}
              className="text-[#00FFFF] font-medium hover:underline cursor-pointer"
            >
              {isRegister ? 'Sign in' : 'Register free'}
            </button>
          </p>
        </div>
      </div>

      <p className="text-center text-xs text-zinc-600">
        FACON HOST · Free Bot Cloud Infrastructure
      </p>
    </div>
  );
}
