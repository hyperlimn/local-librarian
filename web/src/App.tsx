import { useEffect, useState, type ReactNode } from "react";

import { DashboardPage } from "./pages/DashboardPage";
import { InventoryPage } from "./pages/InventoryPage";
import { JobsPage } from "./pages/JobsPage";
import { LibrariesPage } from "./pages/LibrariesPage";
import { SafetyPage } from "./pages/SafetyPage";
import { ScansPage } from "./pages/ScansPage";
import { ThemeToggle } from "./components/ThemeToggle";
import { useTheme } from "./useTheme";

const pages = ["dashboard", "libraries", "inventory", "jobs", "scans", "safety"] as const;
type Page = typeof pages[number];

export function App() {
  const [page, setPage] = useState<Page>(() => pageFromHash());
  const [menuOpen, setMenuOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  useEffect(() => {
    const onHash = () => { setPage(pageFromHash()); setMenuOpen(false); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
          <NavItem page="jobs" current={page} icon="pulse" onSelect={navigate}>Jobs</NavItem>
          <NavItem page="scans" current={page} icon="history" onSelect={navigate}>Scans</NavItem>
        </nav>
        <nav className="sidebar__lower" aria-label="System navigation">
          <NavItem page="safety" current={page} icon="shield" onSelect={navigate}>Safety & diagnostics</NavItem>
        </nav>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
        <div className="sidebar-safety"><span className="sidebar-safety__dot" /><div><strong>Read-only mode</strong><small>File mutation disabled</small></div></div>
      </aside>
      {menuOpen && <button className="menu-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <main className="main-content">
        {page === "dashboard" && <DashboardPage navigate={navigate} />}
        {page === "libraries" && <LibrariesPage navigate={navigate} />}
        {page === "inventory" && <InventoryPage />}
        {page === "jobs" && <JobsPage />}
        {page === "scans" && <ScansPage />}
        {page === "safety" && <SafetyPage />}
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

type IconName = "grid" | "library" | "list" | "pulse" | "history" | "shield";
function Icon({ name }: { readonly name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    library: <><path d="M4 19V5a2 2 0 0 1 2-2h4v18H6a2 2 0 0 1-2-2Z" /><path d="M10 5h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8" /><path d="M14 8h3M14 12h3" /></>,
    list: <><path d="M9 6h12M9 12h12M9 18h12" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
    pulse: <path d="M3 12h4l2-7 4 14 2-7h6" />,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-5" /></>,
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
