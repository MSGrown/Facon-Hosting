import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message || 'An unexpected error occurred.' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-black text-zinc-100 flex items-center justify-center p-6">
          <div className="facon-glass rounded-xl max-w-lg w-full p-6 flex flex-col gap-4">
            <h1 className="font-display text-xl font-semibold text-white">
              Something went wrong
            </h1>
            <p className="text-sm text-zinc-400 break-words font-mono">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="self-start h-10 px-4 rounded-lg bg-[#00FFFF] text-black text-sm font-semibold hover:bg-[#66FFFF] transition-colors cursor-pointer"
            >
              Reload Workspace
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
