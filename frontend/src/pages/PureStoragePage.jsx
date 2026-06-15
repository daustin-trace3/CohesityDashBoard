import { HardDrive, Clock } from 'lucide-react';

export default function PureStoragePage() {
  return (
    <div className="flex items-center justify-center min-h-full animate-fade-in">
      <div className="panel p-12 max-w-md w-full text-center" style={{ borderTop: '3px solid #FF6B00' }}>
        <div className="w-12 h-12 rounded-xl mx-auto mb-4 flex items-center justify-center border" style={{ backgroundColor: '#FF6B0015', borderColor: '#FF6B0040' }}>
          <HardDrive size={22} style={{ color: '#FF6B00' }} />
        </div>
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#FF6B00' }}>Pure Storage</h1>
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink mb-3"><Clock size={14} className="text-ink-faint" /> Coming Soon</p>
        <p className="text-sm text-ink-muted leading-relaxed">Pure Storage FlashArray monitoring is planned for a future release. Capacity, performance, and alert telemetry will appear alongside your Cohesity estate.</p>
      </div>
    </div>
  );
}
