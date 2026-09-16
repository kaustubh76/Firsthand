import { Component, type ErrorInfo, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

/** A render-time exception must show up as words, never as an empty page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[firsthand] render failed", error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <section>
        <h1>FIRSTHAND</h1>
        <p className="error">Something broke while rendering: {this.state.error.message}</p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </section>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
