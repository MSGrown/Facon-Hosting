import React, { useEffect, useState } from 'react';
import { Check, Copy, Globe, LogOut, Save, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { updateUserProfileName } from '../services/hostingService';
import {
  CLOUD_RUN_24X7_DEPLOY_COMMAND,
  getHostHealth,
  HostHealthReport,
} from '../services/runnerService';
import { AppPage, FREE_PLAN_SPECS } from '../types/hosting';

interface AccountSettingsPageProps {
  serverCount: number;
  onNavigate: (page: AppPage) => void;
}

const DEFAULT_AVATAR = '/src/assets/images/avatar_engineer_default_1794806162537.jpg';

export function AccountSettingsPage({ serverCount, onNavigate }: AccountSettingsPageProps) {
  const { user, profile, isAdmin, logout } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.displayName || user?.displayName || '');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [hostHealth, setHostHealth] = useState<HostHealthReport | null>(null);
  const [copiedDeploy, setCopiedDeploy] = useState(false);

  useEffect(() => {
    setDisplayName(profile?.displayName || user?.displayName || '');
  }, [profile?.displayName, user?.displayName]);

  useEffect(() => {
    let cancelled = false;
    void getHostHealth()
      .then((report) => {
        if (!cancelled) setHostHealth(report);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyDeploy = async () => {
    try {
      await navigator.clipboard.writeText(CLOUD_RUN_24X7_DEPLOY_COMMAND);
      setCopiedDeploy(true);
      window.setTimeout(() => setCopiedDeploy(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      await updateUserProfileName(user.uid, displayName);
      setSavedMsg('Account profile updated.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
          Account Settings
        </h1>
        <p className="text-sm text-zinc-400 mt-1">
          Manage your developer identity and inspect your Free Cloud Hosting allocation.
        </p>
      </div>

      {/* Profile Card */}
      <form onSubmit={handleSave} className="facon-glass rounded-2xl p-6 flex flex-col gap-6">
        <div className="flex items-center gap-4 pb-5 border-b border-white/[0.08]">
          <img
            src={profile?.photoURL || user?.photoURL || DEFAULT_AVATAR}
            alt="Developer profile avatar"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = DEFAULT_AVATAR;
            }}
            className="w-16 h-16 rounded-xl object-cover border border-white/15 shrink-0"
          />
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold text-white truncate">
              {profile?.displayName || user?.displayName || 'Developer'}
            </h2>
            <p className="text-xs text-zinc-400 truncate">{user?.email}</p>
            <p className="text-xs text-[#00FFFF] mt-1">
              {isAdmin ? 'Platform Administrator' : 'Developer Account'} ·{' '}
              {user?.emailVerified ? 'Verified Email' : 'Pending Verification'}
            </p>
          </div>
        </div>

        {savedMsg && (
          <div className="rounded-lg border border-[#00FFFF]/30 bg-[#00FFFF]/10 px-4 py-2.5 text-xs text-[#00FFFF]">
            {savedMsg}
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Display Name</label>
            <input
              type="text"
              required
              minLength={1}
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full h-11 px-3.5 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white focus:outline-none focus:border-[#00FFFF]/60"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Primary Email</label>
            <input
              type="email"
              disabled
              value={user?.email || ''}
              className="w-full h-11 px-3.5 rounded-lg bg-[#05080B]/60 border border-white/[0.06] text-sm text-zinc-500"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 pt-2">
          <button
            type="button"
            onClick={() => {
              void logout();
              onNavigate('home');
            }}
            className="h-10 px-4 rounded-lg border border-white/15 text-xs font-medium text-zinc-300 hover:text-rose-400 hover:border-rose-500/40 inline-flex items-center gap-2 cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>

          <button
            type="submit"
            disabled={saving}
            className="h-10 px-5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-2 hover:bg-[#66FFFF] disabled:opacity-40 cursor-pointer"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? 'Saving...' : 'Save Profile'}</span>
          </button>
        </div>
      </form>

      {/* Free Plan Allocation Summary */}
      <div className="facon-glass rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-[#00FFFF]" />
            <h2 className="font-display text-lg font-semibold text-white">Active Hosting Plan</h2>
          </div>
          <span className="font-mono text-sm font-bold text-[#00FFFF]">FREE</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2 border-t border-white/[0.08] text-xs">
          <div>
            <p className="text-zinc-500">Memory Per Server</p>
            <p className="font-mono text-sm font-semibold text-white mt-0.5">{FREE_PLAN_SPECS.ramLabel}</p>
          </div>
          <div>
            <p className="text-zinc-500">CPU Allocation</p>
            <p className="font-mono text-sm font-semibold text-white mt-0.5">{FREE_PLAN_SPECS.cpuLabel}</p>
          </div>
          <div>
            <p className="text-zinc-500">NVMe Disk</p>
            <p className="font-mono text-sm font-semibold text-white mt-0.5">{FREE_PLAN_SPECS.diskLabel}</p>
          </div>
          <div>
            <p className="text-zinc-500">Bandwidth</p>
            <p className="font-mono text-sm font-semibold text-white mt-0.5">{FREE_PLAN_SPECS.bandwidthLabel}</p>
          </div>
          <div>
            <p className="text-zinc-500">Backups Per Server</p>
            <p className="font-mono text-sm font-semibold text-white mt-0.5">{FREE_PLAN_SPECS.backupsLabel}</p>
          </div>
          <div>
            <p className="text-zinc-500">Servers Deployed</p>
            <p className="font-mono text-sm font-semibold text-white tabular-nums mt-0.5">
              {serverCount} /{' '}
              {Math.max(
                FREE_PLAN_SPECS.maxServersPerUser,
                profile?.serverLimit || FREE_PLAN_SPECS.maxServersPerUser
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Domain & 24/7 Always-Online Host Status */}
      <div className="facon-glass rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <Globe className="w-5 h-5 text-[#00FFFF]" />
            <h2 className="font-display text-lg font-semibold text-white">Domain &amp; 24/7 Always-Online Mode</h2>
          </div>
          <span
            className={`px-2.5 py-1 rounded border font-mono text-[11px] uppercase font-semibold ${
              hostHealth?.uptimeMode === 'dedicated-24x7'
                ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300'
                : hostHealth?.uptimeMode === 'ai-studio-auto-sleep'
                ? 'border-amber-400/40 bg-amber-400/15 text-amber-300'
                : 'border-white/15 bg-white/[0.04] text-zinc-400'
            }`}
          >
            {hostHealth?.uptimeMode === 'dedicated-24x7'
              ? 'Dedicated 24/7 Host'
              : hostHealth?.uptimeMode === 'ai-studio-auto-sleep'
              ? 'AI Studio Auto-Sleep Preview'
              : 'Checking Mode'}
          </span>
        </div>

        <div className="grid sm:grid-cols-2 gap-4 pt-2 border-t border-white/[0.08] text-xs">
          <div>
            <p className="text-zinc-500">Configured Custom Domain</p>
            <p className="font-mono text-sm text-[#00FFFF] mt-0.5 break-all">
              {hostHealth?.publicDomain || 'https://faconmodshosting.ai.studio'}
            </p>
          </div>
          <div>
            <p className="text-zinc-500">Active Runners / Chrome-Closed Persistence</p>
            <p className="font-mono text-sm text-white mt-0.5">
              {hostHealth ? `${hostHealth.activeRunners} running` : '—'} ·{' '}
              {hostHealth?.uptimeMode === 'dedicated-24x7'
                ? 'No browser visits required'
                : 'Sleeps ~15–20m on preview'}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-[#05080B] p-4 flex flex-col gap-2.5 text-xs text-zinc-300">
          <p className="leading-relaxed">
            AI Studio preview URLs (<span className="font-mono text-white">*.ai.studio</span> /{' '}
            <span className="font-mono text-white">ais-pre-*</span>) automatically hibernate 15–20 minutes after you close Chrome and cannot keep background bots running for months without visits. To stay online 24/7 permanently with Chrome closed and zero 2-month check-ins, deploy the included{' '}
            <span className="font-mono text-[#00FFFF]">Dockerfile</span> to Cloud Run with{' '}
            <span className="font-mono text-white">--min-instances=1 --no-cpu-throttling</span>:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 rounded-lg bg-black border border-white/10 font-mono text-[11px] text-[#00FFFF] overflow-x-auto whitespace-nowrap">
              {CLOUD_RUN_24X7_DEPLOY_COMMAND}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyDeploy()}
              className="h-9 px-3 rounded-lg border border-white/15 bg-white/[0.04] text-zinc-200 hover:border-[#00FFFF]/50 hover:text-[#00FFFF] inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              {copiedDeploy ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedDeploy ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
