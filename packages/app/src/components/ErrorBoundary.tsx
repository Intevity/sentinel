import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { openBugReport } from '../lib/bugReport.js';

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

/** Catches render-time exceptions so a thrown error surfaces as a recoverable
 *  card instead of unmounting the entire tree into a blank window. The tray
 *  remains usable and the user can click "Reload" to remount App.
 */
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[Sentinel UI] Render error:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  reload = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  report = (): void => {
    const { error, componentStack } = this.state;
    if (!error) return;
    void openBugReport({
      source: 'error-boundary',
      error: {
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
        ...(componentStack ? { componentStack } : {}),
      },
    });
  };

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex flex-col h-full bg-[#F2F2F7] dark:bg-[#111111] items-center justify-center p-6 text-center">
          <AlertTriangle size={32} className="text-ios-red mb-3" strokeWidth={2} />
          <p className="text-[14px] font-semibold text-black dark:text-white mb-1">
            Something broke in the UI
          </p>
          <p className="text-[11px] text-[#8E8E93] max-w-[320px] leading-snug">
            {this.state.error.message || 'Unknown error'}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={this.reload}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-full bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all"
            >
              Reload
            </button>
            <button
              onClick={this.report}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-full border border-ios-blue text-ios-blue hover:bg-ios-blue/10 active:scale-95 transition-all"
            >
              Report this crash
            </button>
          </div>
          <details className="mt-3 text-[10px] text-[#8E8E93] max-w-[360px] text-left">
            <summary className="cursor-pointer">Technical details</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono">
              {this.state.error.stack ?? this.state.error.toString()}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
