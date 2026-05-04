export default function ReportingPage() {
  return (
    <div className="flex items-center justify-center min-h-full">
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-12 max-w-md w-full text-center" style={{ borderTop: '4px solid #a855f7' }}>
        <div className="w-8 h-8 rounded mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: '#a855f722' }}>
          <span style={{ color: '#a855f7', fontSize: 20 }}>&#x2630;</span>
        </div>
        <h1 className="text-2xl font-bold mb-2" style={{ color: '#a855f7' }}>Reporting</h1>
        <p className="text-lg font-semibold text-cohesity-text mb-3">Coming Soon</p>
        <p className="text-sm text-gray-400">Automated reporting and scheduled exports are planned for a future release.</p>
      </div>
    </div>
  );
}
