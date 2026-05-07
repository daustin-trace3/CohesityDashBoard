import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-20 px-6 text-center" role="alert">
          <div className="mb-5 text-red-500 opacity-70" aria-hidden="true">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="24" cy="24" r="20" />
              <path d="M24 14v12M24 31v2" strokeLinecap="round" />
            </svg>
          </div>
          <h2 className="text-base font-semibold text-red-400 mb-2">
            Something went wrong on this page
          </h2>
          <p className="text-xs text-gray-500 max-w-sm leading-relaxed mb-6">
            {this.state.error?.message || 'An unexpected error occurred.'}
            {' '}The rest of the application is still running.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={this.handleReset}
              className="text-xs px-4 py-2 bg-cohesity-green text-cohesity-black rounded font-semibold hover:bg-cohesity-green-dark transition-colors"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="text-xs px-4 py-2 border border-cohesity-border rounded text-gray-400 hover:border-cohesity-green hover:text-cohesity-green transition-colors"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
