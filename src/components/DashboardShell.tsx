import React, { useState } from 'react';
import {
  LayoutDashboard,
  Server,
  PlusSquare,
  Terminal,
  FolderCode,
  Sliders,
  Archive,
  Settings,
  ShieldAlert,
  Menu,
  X,
  LogOut,
  ChevronDown,
} from 'lucide-react';
import { AppPage, BotServer } from '../types/hosting';
import { BrandMark } from './BrandMark';
import { useAuth } from '../context/AuthContext';

interface DashboardShellProps {
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
  servers: BotServer[];
  activeServer: BotServer | null;
  onSelectServer: (serverId: string) => void;
  children: React.ReactNode;
}

const PAGE_TITLES: Record<AppPage, string> = {
  home: 'Home',
  login: 'Login',
  register: 'Register',
  dashboard: 'Dashboard',
  servers: 'Servers',
  'create-server': 'Create Server',
  console: 'Console',
  files: 'File Manager',
  startup: 'Startup & Environment',
  backups: 'Backups',
  settings: 'Account Settings',
  admin: 'Admin Panel',
};

const DEFAULT_AVATAR = '/src/assets/images/avatar_engineer_default_1794806162537.jpg';

export function DashboardShell({
  currentPage,
  onNavigate,
  servers,
  activeServer,
  onSelectServer,
  children,
}: DashboardShellProps) {
  const { user, profile, isAdmin, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const primaryNav: { id: AppPage; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'servers', label: 'Servers', icon: Server },
    { id: 'create-server', label: 'Create Server', icon: PlusSquare },
  ];

  const workspaceNav: { id: AppPage; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'console', label: 'Console', icon: Terminal },
    { id: 'files', label: 'File Manager', icon: FolderCode },
    { id: 'startup', label: 'Startup & Env', icon: Sliders },
    { id: 'backups', label: 'Backups', icon: Archive },
  ];

  const accountNav: { id: AppPage; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'settings', label: 'Account Settings', icon: Settings },
    ...(isAdmin ? [{ id: 'admin' as AppPage, label: 'Admin Panel', icon: ShieldAlert }] : []),
  ];

  const handleSelectNav = (page: AppPage) => {
    onNavigate(page);
    setMobileOpen(false);
  };

  const renderNavContent = () => (
    <div className="flex flex-col h-full justify-between p-4 gap-6">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between px-2 pt-1">
          <button
            type="button"
            onClick={() => handleSelectNav('home')}
            className="text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00FFFF] rounded"
          >
            <BrandMark />
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="lg:hidden h-9 w-9 inline-flex items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 cursor-pointer"
            aria-label="Close navigation menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Cloud Control Group */}
        <div>
          <p className="px-3 mb-2 text-[11px] font-medium text-zinc-500">Cloud Control</p>
          <nav className="flex flex-col gap-1">
            {primaryNav.map((item) => {
              const Icon = item.icon;
              const active = currentPage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectNav(item.id)}
                  className={`h-10 px-3 rounded-lg text-sm font-medium flex items-center gap-3 transition-colors whitespace-nowrap cursor-pointer ${
                    active
                      ? 'bg-[#00FFFF]/10 text-[#00FFFF] border border-[#00FFFF]/25'
                      : 'text-zinc-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Active Server Workspace Group */}
        <div>
          <p className="px-3 mb-2 text-[11px] font-medium text-zinc-500">Server Workspace</p>
          {servers.length > 0 && (
            <div className="px-1 mb-2">
              <div className="relative">
                <select
                  aria-label="Active server selector"
                  value={activeServer?.id || ''}
                  onChange={(e) => onSelectServer(e.target.value)}
                  className="w-full h-9 pl-3 pr-8 rounded-lg bg-[#05080B] border border-white/10 text-xs font-medium text-zinc-200 appearance-none focus:outline-none focus:border-[#00FFFF]/60 cursor-pointer truncate"
                >
                  {servers.map((srv) => (
                    <option key={srv.id} value={srv.id} className="bg-[#090C10] text-zinc-100">
                      {srv.name} ({srv.runtime})
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>
          )}

          <nav className="flex flex-col gap-1">
            {workspaceNav.map((item) => {
              const Icon = item.icon;
              const active = currentPage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectNav(item.id)}
                  className={`h-10 px-3 rounded-lg text-sm font-medium flex items-center gap-3 transition-colors whitespace-nowrap cursor-pointer ${
                    active
                      ? 'bg-[#00FFFF]/10 text-[#00FFFF] border border-[#00FFFF]/25'
                      : 'text-zinc-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Account & Admin */}
        <div>
          <p className="px-3 mb-2 text-[11px] font-medium text-zinc-500">Account</p>
          <nav className="flex flex-col gap-1">
            {accountNav.map((item) => {
              const Icon = item.icon;
              const active = currentPage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectNav(item.id)}
                  className={`h-10 px-3 rounded-lg text-sm font-medium flex items-center gap-3 transition-colors whitespace-nowrap cursor-pointer ${
                    active
                      ? 'bg-[#00FFFF]/10 text-[#00FFFF] border border-[#00FFFF]/25'
                      : 'text-zinc-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Bottom User Card */}
      <div className="pt-4 border-t border-white/[0.08] flex items-center justify-between gap-3 px-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src={profile?.photoURL || user?.photoURL || DEFAULT_AVATAR}
            alt={profile?.displayName || 'Developer avatar'}
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = DEFAULT_AVATAR;
            }}
            className="w-8 h-8 rounded-lg object-cover border border-white/10 shrink-0"
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-white truncate">
              {profile?.displayName || user?.displayName || 'Developer'}
            </p>
            <p className="text-[11px] text-zinc-500 truncate">
              Free Plan · {servers.length}/5 nodes
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void logout();
            onNavigate('home');
          }}
          title="Sign out"
          className="h-9 w-9 rounded-lg inline-flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors shrink-0 cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-white/[0.08] bg-[#040608] sticky top-0 h-screen overflow-y-auto">
        {renderNavContent()}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] bg-[#05080B] border-r border-white/10 h-full overflow-y-auto">
            {renderNavContent()}
          </aside>
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract */}
        <header className="sticky top-0 z-30 h-16 px-4 sm:px-6 lg:px-8 border-b border-white/[0.08] bg-black/80 backdrop-blur-md flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden h-10 w-10 rounded-lg inline-flex items-center justify-center border border-white/10 text-zinc-300 hover:text-white hover:bg-white/5 cursor-pointer"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0 truncate">
              <span className="text-zinc-500 hidden sm:inline">FACON HOST</span>
              <span className="text-zinc-700 hidden sm:inline">/</span>
              <span className="font-medium text-white truncate">{PAGE_TITLES[currentPage]}</span>
              {activeServer && ['console', 'files', 'startup', 'backups'].includes(currentPage) && (
                <>
                  <span className="text-zinc-700">/</span>
                  <span className="text-[#00FFFF] font-mono text-xs truncate">{activeServer.name}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('create-server')}
              className="h-9 px-4 rounded-lg text-xs font-semibold bg-[#00FFFF] text-black hover:bg-[#66FFFF] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Deploy Free Server
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1360px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
