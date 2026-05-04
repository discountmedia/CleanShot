// =============================================================================
//  App — outer shell. Top bar (brand + title), tab switcher, content area.
// =============================================================================

import { Sparkles, ScanLine, Maximize2 } from 'lucide-react';

import { useStore, type TabId } from './lib/store';
import { EnhanceTab } from './tabs/EnhanceTab';
import { ScanTab } from './tabs/ScanTab';
import { ResizeTab } from './tabs/ResizeTab';

interface TabConfig {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

const TABS: TabConfig[] = [
  { id: 'enhance', label: 'Enhance', icon: Sparkles },
  { id: 'scan',    label: 'Scan',    icon: ScanLine },
  { id: 'resize',  label: 'Resize',  icon: Maximize2 },
];

export default function App() {
  const activeTab = useStore((s) => s.active_tab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const session_id = useStore((s) => s.session_id);

  return (
    <div className="app">
      {/* ---- Top bar ---- */}
      <div className="top-bar">
        <span className="brand-mark">CleanShot</span>
        <span className="top-bar-title">Forklift Image Toolkit</span>
        <div className="top-bar-spacer" />
        <span className="top-bar-meta">
          {session_id ? `Session ${session_id.slice(-8)}` : 'No active session'}
        </span>
      </div>

      {/* ---- Tab switcher ---- */}
      <div className="tab-bar">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`tab ${activeTab === id ? 'active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* ---- Content ---- */}
      <main className="main">
        {activeTab === 'enhance' && <EnhanceTab />}
        {activeTab === 'scan' && <ScanTab />}
        {activeTab === 'resize' && <ResizeTab />}
      </main>
    </div>
  );
}
