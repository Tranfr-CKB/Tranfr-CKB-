import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
}

/**
 * A crash in the app would otherwise leave a blank page, with the user's keys
 * and tracked cells still in local storage and no way to see what happened.
 * This keeps the page readable and offers a reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Tranfr demo crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="page-shell">
        <section className="policy-card">
          <div className="corner corner-top-left" aria-hidden="true" />
          <div className="corner corner-top-right" aria-hidden="true" />
          <div className="corner corner-bottom-left" aria-hidden="true" />
          <div className="corner corner-bottom-right" aria-hidden="true" />
          <div className="create-policy-form">
            <header className="policy-header">
              <h1>Something broke</h1>
              <p>
                The page hit an error it couldn&rsquo;t recover from. Your keys and tracked policies are still in this
                browser&rsquo;s local storage — reloading does not lose them.
              </p>
            </header>
            <p className="error wrap">{error.message}</p>
            <button type="button" className="submit-button" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </section>
      </main>
    );
  }
}
