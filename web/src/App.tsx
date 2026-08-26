import { useEffect, useState, type ReactNode } from "react";

import { DashboardPage } from "./pages/DashboardPage";
import { AnalyzePage } from "./pages/AnalyzePage";
import { DuplicatesPage } from "./pages/DuplicatesPage";
import { IngestPage } from "./pages/IngestPage";
import { InventoryPage } from "./pages/InventoryPage";
import { NeedsReviewPage } from "./pages/NeedsReviewPage";
import { OrganizePage } from "./pages/OrganizePage";
import { QuarantinePage } from "./pages/QuarantinePage";
import { JobsPage } from "./pages/JobsPage";
import { LibrariesPage } from "./pages/LibrariesPage";
import { SafetyPage } from "./pages/SafetyPage";
import { ScansPage } from "./pages/ScansPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ThemeToggle } from "./components/ThemeToggle";
import { useTheme } from "./useTheme";
import { api } from "./api";
import type { SystemState } from "./types";

const pages = [
  "dashboard", "libraries", "inventory", "analyze", "duplicates", "organize",
  "needs-review", "ingest", "quarantine", "jobs", "scans", "safety", "settings",
] as const;
type Page = typeof pages[number];

export function App() {
  const [page, setPage] = useState<Page>(() => pageFromHash());
  const [menuOpen, setMenuOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const [system, setSystem] = useState<SystemState>();
  useEffect(() => {
    const onHash = () => { setPage(pageFromHash()); setMenuOpen(false); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const load = () => void api<SystemState>("/api/system").then(setSystem).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 5_000);
    return () => window.clearInterval(timer);
  }, []);
  function navigate(next: string) {
    if (!isPage(next)) return;
    window.location.hash = next;
    setPage(next);
    setMenuOpen(false);
  }
  return (
    <div className="app-shell">
      <header className="mobile-header"><Brand compact /><div className="mobile-header__actions"><ThemeToggle theme={theme} onToggle={toggleTheme} compact /><button className="icon-button" aria-label="Toggle navigation" onClick={() => setMenuOpen((open) => !open)}><span /><span /><span /></button></div></header>
      <aside className={`sidebar ${menuOpen ? "sidebar--open" : ""}`}>
        <Brand />
        <nav aria-label="Primary navigation">
          <NavItem page="dashboard" current={page} icon="grid" onSelect={navigate}>Dashboard</NavItem>
          <NavItem page="libraries" current={page} icon="library" onSelect={navigate}>Libraries</NavItem>
          <NavItem page="inventory" current={page} icon="list" onSelect={navigate}>Inventory</NavItem>
          <NavItem page="analyze" current={page} icon="spark" onSelect={navigate}>Analyze</NavItem>
          <NavItem page="duplicates" current={page} icon="copies" onSelect={navigate}>Duplicates</NavItem>
          <NavItem page="needs-review" current={page} icon="review" onSelect={navigate}>Needs Review</NavItem>
          <NavItem page="ingest" current={page} icon="ingest" onSelect={navigate}>Ingest</NavItem>
          <NavItem page="jobs" current={page} icon="pulse" onSelect={navigate}>Jobs</NavItem>
          <NavItem page="scans" current={page} icon="history" onSelect={navigate}>Scans</NavItem>
          <NavItem page="organize" current={page} icon="organize" onSelect={navigate}>Organize / Activity</NavItem>
          <NavItem page="quarantine" current={page} icon="recover" onSelect={navigate}>Quarantine</NavItem>
        </nav>
        <nav className="sidebar__lower" aria-label="System navigation">
          <NavItem page="safety" current={page} icon="shield" onSelect={navigate}>Safety & diagnostics</NavItem>
          <NavItem page="settings" current={page} icon="settings" onSelect={navigate}>Settings</NavItem>
        </nav>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
        <div className={`sidebar-safety ${system?.mutationMode.mode === "live" ? "sidebar-safety--live" : ""}`}><span className="sidebar-safety__dot" /><div><strong>{system?.mutationMode.mode === "live" ? "Live mutation mode" : "Read-only testing"}</strong><small>{system?.mutationMode.mode === "live" ? "Per-library approval required" : "File mutation disabled"}</small></div></div>
      </aside>
      {menuOpen && <button className="menu-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <main className="main-content">
        {page === "dashboard" && <DashboardPage navigate={navigate} />}
        {page === "libraries" && <LibrariesPage navigate={navigate} />}
        {page === "inventory" && <InventoryPage />}
        {page === "analyze" && <AnalyzePage />}
        {page === "duplicates" && <DuplicatesPage navigate={navigate} />}
        {page === "needs-review" && <NeedsReviewPage navigate={navigate} />}
        {page === "ingest" && <IngestPage navigate={navigate} />}
        {page === "quarantine" && <QuarantinePage />}
        {page === "jobs" && <JobsPage />}
        {page === "scans" && <ScansPage />}
        {page === "safety" && <SafetyPage />}
        {page === "settings" && <SettingsPage />}
        {page === "organize" && <OrganizePage />}
      </main>
    </div>
  );
}

function Brand({ compact = false }: { readonly compact?: boolean }) {
  return <a className={`brand ${compact ? "brand--compact" : ""}`} href="#dashboard"><span className="brand__mark" aria-hidden="true"><i /><i /><i /></span><span><strong>Local Librarian</strong><small>Private library control</small></span></a>;
}

function NavItem({ page, current, icon, onSelect, children }: {
  readonly page: Page;
  readonly current: Page;
  readonly icon: IconName;
  readonly onSelect: (page: Page) => void;
  readonly children: ReactNode;
}) {
  return <button className={`nav-item ${page === current ? "nav-item--active" : ""}`} onClick={() => onSelect(page)}><Icon name={icon} />{children}</button>;
}

type IconName = "grid" | "library" | "list" | "organize" | "pulse" | "history" |
  "shield" | "spark" | "copies" | "review" | "ingest" | "recover" | "settings";
function Icon({ name }: { readonly name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    library: <><path d="M4 19V5a2 2 0 0 1 2-2h4v18H6a2 2 0 0 1-2-2Z" /><path d="M10 5h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8" /><path d="M14 8h3M14 12h3" /></>,
    list: <><path d="M9 6h12M9 12h12M9 18h12" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
    pulse: <path d="M3 12h4l2-7 4 14 2-7h6" />,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-5" /></>,
    organize: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="m7 3 2 3-2 3M13 9l2 3-2 3M7 15l2 3-2 3" /></>,
    spark: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></>,
    copies: <><rect x="7" y="7" width="13" height="13" rx="2" /><path d="M4 17H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v1" /></>,
    review: <><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.3 2.3 0 1 1 3.6 1.9c-.9.6-1.4 1-1.4 2.1M12 17h.01" /></>,
    ingest: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M4 17v3h16v-3" /></>,
    recover: <><path d="M4 7h16l-1 14H5L4 7Z" /><path d="M8 7V3h8v4M9 13h6M12 10v6" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function pageFromHash(): Page {
  const candidate = window.location.hash.replace(/^#\/?/u, "");
  return isPage(candidate) ? candidate : "dashboard";
}

function isPage(value: string): value is Page {
  return (pages as readonly string[]).includes(value);
}
