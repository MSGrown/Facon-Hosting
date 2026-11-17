import React, { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Check, Cpu, HardDrive, ShieldCheck, Terminal, Wifi, Archive } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import {
  AppPage,
  FREE_PLAN_SPECS,
  SUPPORTED_APPLICATIONS,
  SUPPORTED_RUNTIMES,
  SupportedRuntime,
} from '../types/hosting';
import { useAuth } from '../context/AuthContext';

interface HomePageProps {
  onNavigate: (page: AppPage) => void;
}

const HERO_IMG = '/src/assets/images/hero_cloud_infrastructure_1794806161689.jpg';
const CLUSTER_IMG = '/src/assets/images/architecture_node_cluster_1794806162650.jpg';

export function HomePage({ onNavigate }: HomePageProps) {
  const { user } = useAuth();
  const [selectedRuntime, setSelectedRuntime] = useState<SupportedRuntime>('Python');

  const activeRuntimeObj =
    SUPPORTED_RUNTIMES.find((r) => r.id === selectedRuntime) || SUPPORTED_RUNTIMES[0];

  const handlePrimaryCta = () => {
    onNavigate(user ? 'dashboard' : 'register');
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-black/80 backdrop-blur-md">
        <div className="max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="whitespace-nowrap shrink-0"
          >
            <BrandMark />
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-400">
            <a href="#runtimes" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Runtimes
            </a>
            <a href="#applications" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Applications
            </a>
            <a href="#free-plan" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Free Plan
            </a>
            <button
              type="button"
              onClick={() => onNavigate(user ? 'dashboard' : 'login')}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {user ? 'Console' : 'Login'}
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={handlePrimaryCta}
              className="h-10 px-5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold hover:bg-[#66FFFF] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {user ? 'Open Dashboard' : 'Deploy Free'}
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section id="top" className="max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-16 lg:pt-20 lg:pb-20">
        <div className="grid lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-6 flex flex-col justify-center gap-6"
          >
            <p className="text-xs font-medium text-[#00FFFF] tracking-wide">
              Cloud Bot Hosting · Zero Cost Forever
            </p>
            <h1
              className="font-display font-bold tracking-tight text-white leading-[1.06]"
              style={{ fontSize: 'clamp(2.35rem, 4.3vw, 3.85rem)', textWrap: 'balance' }}
            >
              Your Bots. Your Power. Absolutely Free.
            </h1>
            <p className="text-base sm:text-lg text-zinc-400 leading-relaxed max-w-xl">
              Deploy persistent Discord, Telegram, WhatsApp bots, and custom services across nine
              native runtimes. Isolated containers with real-time console streaming, file management,
              and automated snapshots—without a credit card.
            </p>

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <button
                type="button"
                onClick={handlePrimaryCta}
                className="h-12 px-6 rounded-lg bg-[#00FFFF] text-black text-sm font-semibold inline-flex items-center gap-2 hover:bg-[#66FFFF] transition-colors whitespace-nowrap cursor-pointer"
              >
                <span>{user ? 'Go to Dashboard' : 'Launch Free Server'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <a
                href="#free-plan"
                className="h-12 px-6 rounded-lg border border-white/15 bg-white/[0.03] text-zinc-200 text-sm font-medium inline-flex items-center hover:border-white/30 hover:text-white transition-colors whitespace-nowrap"
              >
                Inspect Free Plan Specs
              </a>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-6 relative rounded-2xl overflow-hidden border border-white/10 bg-[#070A0E] min-h-[280px] lg:min-h-[420px]"
          >
            <img
              src={HERO_IMG}
              alt="FACON HOST obsidian server infrastructure rack with cyan fiber optic interconnects"
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
              className="w-full h-full object-cover lg:h-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent pointer-events-none" />
            <div className="absolute bottom-5 left-5 right-5 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs text-zinc-400">Dedicated Container Allocation</p>
                <p className="font-display text-lg font-semibold text-white">
                  20 GB RAM · 500% vCPU · 20 GB NVMe
                </p>
              </div>
              <p className="font-mono text-xs text-[#00FFFF] tabular-nums">500 Mbps Uplink</p>
            </div>
          </motion.div>
        </div>

        {/* Full-Width 4-Column Hardware Allocation Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-10">
          {[
            { label: 'Dedicated Memory', value: FREE_PLAN_SPECS.ramLabel, detail: 'ECC DDR5 per container' },
            { label: 'Compute Burst', value: FREE_PLAN_SPECS.cpuLabel, detail: '5 dedicated vCPU threads' },
            { label: 'NVMe Storage', value: FREE_PLAN_SPECS.diskLabel, detail: '5 snapshots · up to 10 servers' },
            { label: 'Plan Cost', value: FREE_PLAN_SPECS.priceLabel, detail: '500 Mbps · zero billing' },
          ].map((item) => (
            <div key={item.label} className="facon-glass rounded-xl p-5">
              <p className="text-xs text-zinc-400">{item.label}</p>
              <p className="font-mono text-2xl sm:text-3xl font-semibold text-white tabular-nums mt-1.5">
                {item.value}
              </p>
              <p className="text-xs text-zinc-500 mt-1">{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Supported Runtimes Interactive Explorer */}
      <section id="runtimes" className="border-t border-white/[0.08] py-16 lg:py-24">
        <div className="max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
            <div>
              <p className="text-xs font-medium text-[#00FFFF] mb-2">01. Multi-Language Runtime Engine</p>
              <h2 className="font-display text-3xl sm:text-4xl font-bold text-white tracking-tight">
                Nine Native Runtimes. Zero Configuration.
              </h2>
            </div>
            <p className="text-sm text-zinc-400 max-w-md">
              Select a language below to preview its pre-configured startup command, entry file, and
              supported workloads.
            </p>
          </div>

          <div className="grid lg:grid-cols-12 gap-6 items-stretch">
            <div className="lg:col-span-7 grid grid-cols-2 sm:grid-cols-3 gap-3">
              {SUPPORTED_RUNTIMES.map((rt) => {
                const active = rt.id === selectedRuntime;
                return (
                  <button
                    key={rt.id}
                    type="button"
                    onClick={() => setSelectedRuntime(rt.id)}
                    className={`text-left p-4 rounded-xl border transition-all cursor-pointer ${
                      active
                        ? 'bg-[#00FFFF]/10 border-[#00FFFF]/60 text-white'
                        : 'facon-glass border-white/10 text-zinc-300 hover:border-white/25 hover:text-white'
                    }`}
                  >
                    <p className="font-display font-semibold text-base">{rt.id}</p>
                    <p className="font-mono text-xs text-zinc-400 mt-1">{rt.version}</p>
                  </button>
                );
              })}
            </div>

            <div className="lg:col-span-5 facon-glass rounded-xl p-6 flex flex-col justify-between gap-6">
              <div>
                <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.08]">
                  <div>
                    <h3 className="font-display text-2xl font-semibold text-white">
                      {activeRuntimeObj.id}
                    </h3>
                    <p className="text-xs text-zinc-400 mt-0.5">{activeRuntimeObj.version}</p>
                  </div>
                  <Terminal className="w-5 h-5 text-[#00FFFF]" />
                </div>

                <p className="text-sm text-zinc-300 leading-relaxed mt-4">
                  {activeRuntimeObj.summary}
                </p>

                <div className="mt-5 space-y-3">
                  <div>
                    <p className="text-xs text-zinc-500 mb-1">Default Startup Command</p>
                    <div className="rounded-lg bg-black/80 border border-white/10 px-3.5 py-2.5 font-mono text-xs text-[#00FFFF] overflow-x-auto">
                      $ {activeRuntimeObj.defaultCmd}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-500 mb-1">Generated Entrypoint</p>
                    <p className="font-mono text-xs text-zinc-300">{activeRuntimeObj.entryFile}</p>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={handlePrimaryCta}
                className="h-10 px-4 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center justify-center gap-2 hover:bg-[#66FFFF] transition-colors cursor-pointer"
              >
                <span>Deploy {activeRuntimeObj.id} Server</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Supported Applications Bento */}
      <section id="applications" className="border-t border-white/[0.08] py-16 lg:py-24">
        <div className="max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-10">
            <p className="text-xs font-medium text-[#00FFFF] mb-2">02. Purpose-Built Workloads</p>
            <h2 className="font-display text-3xl sm:text-4xl font-bold text-white tracking-tight">
              Always-On Bot & Service Hosting
            </h2>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
            {SUPPORTED_APPLICATIONS.map((app, index) => (
              <div key={app.id} className="facon-glass facon-glass-hover rounded-xl p-6 flex flex-col justify-between gap-5">
                <div>
                  <p className="font-mono text-xs text-zinc-500 mb-3">0{index + 1}</p>
                  <h3 className="font-display text-xl font-semibold text-white">{app.id}</h3>
                  <p className="text-sm text-zinc-400 leading-relaxed mt-2.5">{app.description}</p>
                </div>
                <div className="pt-4 border-t border-white/[0.07]">
                  <p className="text-[11px] text-zinc-500 mb-1">Popular Runtimes</p>
                  <p className="text-xs text-zinc-200">
                    {app.recommendedRuntimes.slice(0, 3).join(' · ')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Free Plan Architecture & Specification Sheet */}
      <section id="free-plan" className="border-t border-white/[0.08] py-16 lg:py-24">
        <div className="max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-12 gap-8 items-stretch">
            <div className="lg:col-span-6 facon-glass rounded-2xl p-6 sm:p-8 flex flex-col justify-between gap-6">
              <div>
                <p className="text-xs font-medium text-[#00FFFF] mb-2">03. Free Cloud Plan</p>
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="font-display text-3xl font-bold text-white">
                    Standard Free Node
                  </h2>
                  <span className="font-mono text-2xl font-bold text-[#00FFFF]">FREE</span>
                </div>
                <p className="text-sm text-zinc-400 mt-3">
                  Every developer receives full access to production-grade container controls, live
                  console streaming, file uploads, and snapshot backups at zero cost.
                </p>

                <div className="mt-6 divide-y divide-white/[0.08] border-y border-white/[0.08]">
                  {[
                    { icon: Cpu, label: 'CPU Allocation', value: FREE_PLAN_SPECS.cpuLabel },
                    { icon: ShieldCheck, label: 'Memory (RAM)', value: FREE_PLAN_SPECS.ramLabel },
                    { icon: HardDrive, label: 'NVMe Disk Storage', value: FREE_PLAN_SPECS.diskLabel },
                    { icon: Wifi, label: 'Network Bandwidth', value: FREE_PLAN_SPECS.bandwidthLabel },
                    { icon: Archive, label: 'Snapshot Backups', value: `${FREE_PLAN_SPECS.backupsLabel} Backups` },
                    { icon: Terminal, label: 'Deploy Servers', value: `Up to ${FREE_PLAN_SPECS.maxServersPerUser} Servers` },
                    { icon: Check, label: 'Monthly Price', value: FREE_PLAN_SPECS.priceLabel },
                  ].map((spec) => {
                    const Icon = spec.icon;
                    return (
                      <div key={spec.label} className="py-3.5 flex items-center justify-between gap-4">
                        <span className="inline-flex items-center gap-2.5 text-sm text-zinc-300">
                          <Icon className="w-4 h-4 text-[#00FFFF]" />
                          <span>{spec.label}</span>
                        </span>
                        <span className="font-mono text-sm font-semibold text-white tabular-nums">
                          {spec.value}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={handlePrimaryCta}
                className="h-11 px-6 rounded-lg bg-[#00FFFF] text-black text-sm font-semibold inline-flex items-center justify-center gap-2 hover:bg-[#66FFFF] transition-colors cursor-pointer"
              >
                <span>{user ? 'Create Server Now' : 'Create Free Account'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            <div className="lg:col-span-6 rounded-2xl overflow-hidden border border-white/10 bg-[#05070A] flex flex-col justify-between">
              <div className="flex-1 min-h-[260px] relative">
                <img
                  src={CLUSTER_IMG}
                  alt="Isometric FACON HOST compute node cluster architecture"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="p-6 border-t border-white/[0.08] bg-[#070A0E]">
                <h3 className="font-display text-lg font-semibold text-white">
                  Full Workspace Control Included
                </h3>
                <p className="text-sm text-zinc-400 mt-1.5 leading-relaxed">
                  Real-time interactive console, browser-based file manager with drag-and-drop
                  upload, custom startup commands, encrypted environment variables, and instant
                  CPU/RAM/Disk telemetry charts.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Quiet Footer */}
      <footer className="border-t border-white/[0.08] py-10">
        <div className="max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <BrandMark />
            <p className="text-xs text-zinc-500 mt-1">
              Your Bots. Your Power. Absolutely Free.
            </p>
          </div>
          <div className="flex items-center gap-6 text-xs text-zinc-400">
            <button type="button" onClick={() => onNavigate('login')} className="hover:text-white cursor-pointer">
              Login
            </button>
            <button type="button" onClick={() => onNavigate('register')} className="hover:text-white cursor-pointer">
              Register
            </button>
            <button type="button" onClick={() => onNavigate('dashboard')} className="hover:text-white cursor-pointer">
              Dashboard
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
