export default function PureStoragePage() {
  return (
    <div className="flex items-center justify-center min-h-full">
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-12 max-w-md w-full text-center"
           style={{ borderTop: '4px solid #FF6B00' }}>
        <div className="w-8 h-8 rounded-full mx-auto mb-4" style={{ backgroundColor: '#FF6B00' }} />
        <h1 className="text-2xl font-bold mb-2" style={{ color: '#FF6B00' }}>Pure Storage</h1>
        <p className="text-lg font-semibold text-cohesity-text mb-3">Coming Soon</p>
        <p className="text-sm text-gray-400">Pure Storage integration is planned for a future release.</p>
      </div>
    </div>
  );
}
