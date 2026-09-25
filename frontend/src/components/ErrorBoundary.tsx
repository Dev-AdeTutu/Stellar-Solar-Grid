"use client";

import { Component, ReactNode } from "react";
import styles from './ErrorBoundary.module.css';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

const ISSUE_URL = "https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/issues/new";

/** Builds a prefilled GitHub issue URL containing the error details. */
export function buildIssueUrl(error: Error | null): string {
  const body = [
    "**Error:** " + (error?.message ?? "unknown"),
    "",
    "```",
    error?.stack ?? "",
    "```",
    "",
    "URL: " + (typeof window !== "undefined" ? window.location.href : ""),
  ].join("\n");
  const params = new URLSearchParams({ title: `Frontend error: ${error?.message ?? "unknown"}`, body });
  return `${ISSUE_URL}?${params.toString()}`;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// Reports render errors to the backend so they're captured somewhere durable
// even in production, where no one is watching the browser console.
// Wiring an external error-tracking service (e.g. Sentry) instead/in addition
// is a separate product/tooling decision — flagging rather than assuming here.
function reportError(error: Error, componentStack: string) {
  try {
    fetch(`${BACKEND_URL}/api/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        componentStack,
        url: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      }),
    }).catch(() => {
      // Best-effort — a failed report shouldn't affect the fallback UI.
    });
  } catch {
    // ignore — e.g. fetch unavailable in this environment
  }
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
    reportError(error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.container}>
          <h2 className={styles.title}>Something went wrong</h2>
          <p className={styles.message}>
            An unexpected error occurred. You can try again or report the issue.
          </p>
          <details>
            <summary>Error details</summary>
            <pre>{this.state.error?.message}</pre>
          </details>
          <button
            className={styles.retryButton}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try Again
          </button>
          <a
            className={styles.retryButton}
            href={buildIssueUrl(this.state.error)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Report Issue
          </a>
        </div>
      );
    }
    return this.props.children;
  }
}
