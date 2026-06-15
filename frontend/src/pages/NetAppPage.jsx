import { Database, Clock } from 'lucide-react';

export default function NetAppPage() {
  return (
    <div className="flex items-center justify-center min-h-full animate-fade-in">
      <div className="panel p-12 max-w-md w-full text-center" style={{ borderTop: '3px solid #0067C5' }}>
        <div className="w-12 h-12 rounded-xl mx-auto mb-4 flex items-center justify-center border" style={{ backgroundColor: '#0067C515', borderColor: '#0067C540' }}>
          <Database size={22} style={{ color: '#0067C5' }} />
        </div>
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#0067C5' }}>NetApp</h1>
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink mb-3"><Clock size={14} className="text-ink-faint" /> Coming Soon</p>
        <p className="text-sm text-ink-muted leading-relaxed">NetApp ONTAP monitoring is planned for a future release. Volume capacity, SnapMirror health, and EMS alerts will appear alongside your Cohesity estate.</p>
      </div>
    </div>
  );
}
