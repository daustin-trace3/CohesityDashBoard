export default function SearchFilterBar({ search, onSearch, connectionFilter, onConnectionFilter, severityFilter, onSeverityFilter }) {
  return (
    <div className="flex flex-wrap gap-3 items-center mb-4">
      <input
        type="text"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search clusters..."
        className="bg-cohesity-black border border-cohesity-border rounded px-3 py-1.5 text-sm text-cohesity-text placeholder-gray-500 focus:outline-none focus:border-cohesity-green min-w-[200px]"
      />

      <div className="flex gap-1">
        {['all', 'helios', 'direct'].map((type) => (
          <button
            key={type}
            onClick={() => onConnectionFilter(type)}
            className={`text-xs px-3 py-1.5 rounded border transition-colors ${
              connectionFilter === type
                ? 'bg-cohesity-green text-cohesity-black border-cohesity-green font-semibold'
                : 'border-cohesity-border text-gray-400 hover:border-cohesity-green'
            }`}
          >
            {type.charAt(0).toUpperCase() + type.slice(1)}
          </button>
        ))}
      </div>

      <button
        onClick={() => onSeverityFilter((v) => !v)}
        className={`text-xs px-3 py-1.5 rounded border transition-colors ${
          severityFilter
            ? 'bg-red-900 text-red-300 border-red-700'
            : 'border-cohesity-border text-gray-400 hover:border-red-700'
        }`}
      >
        Critical Only
      </button>
    </div>
  );
}
