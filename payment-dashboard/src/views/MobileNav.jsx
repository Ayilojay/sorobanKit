import { useRouteFocus } from "../focus/useRouteFocus";

/**
 * @typedef {Object} MobileNavProps
 * @property {string} active
 * @property {() => void} onDashboardClick
 * @property {() => void} onHistoryClick
 * @property {() => void} onAnalyticsClick
 * @property {() => void} onHelpClick
 * @property {() => void} onRegisterClick
 * @property {boolean} canRegister
 */

/**
 * @param {MobileNavProps} props
 */
function MobileNav({
  active,
  onDashboardClick,
  onHistoryClick,
  onAnalyticsClick,
  onHelpClick,
  onRegisterClick,
  canRegister,
}) {
  const { focusRouteHeading } = useRouteFocus();

  /**
   * Wrap a navigation handler so the centralized focus manager moves focus to
   * the destination route heading once the navigation has been triggered.
   * @param {() => void} handler
   * @returns {() => void}
   */
  const navigate = (handler) => () => {
    handler();
    focusRouteHeading();
  };

  return (
    <nav className="mobile-nav" aria-label="Primary" data-testid="mobile-nav">
      <button
        type="button"
        data-testid="mobile-nav-dashboard"
        data-active={active === "dashboard" ? "true" : "false"}
        className={active === "dashboard" ? "is-active" : ""}
        onClick={navigate(onDashboardClick)}
        aria-current={active === "dashboard" ? "page" : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z" />
        </svg>
        <span>Dashboard</span>
      </button>
      <button
        type="button"
        data-testid="mobile-nav-history"
        data-active={active === "history" ? "true" : "false"}
        className={active === "history" ? "is-active" : ""}
        onClick={navigate(onHistoryClick)}
        aria-current={active === "history" ? "page" : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h16M6 12h12M9 19h6" />
        </svg>
        <span>History</span>
      </button>
      <button
        type="button"
        data-testid="mobile-nav-analytics"
        data-active={active === "analytics" ? "true" : "false"}
        className={active === "analytics" ? "is-active" : ""}
        onClick={navigate(onAnalyticsClick)}
        aria-current={active === "analytics" ? "page" : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 19V5m5 14V9m5 10v-6m5 6V7" />
        </svg>
        <span>Analytics</span>
      </button>
      <button
        type="button"
        data-testid="mobile-nav-help"
        data-active={active === "help" ? "true" : "false"}
        className={active === "help" ? "is-active" : ""}
        onClick={navigate(onHelpClick)}
        aria-current={active === "help" ? "page" : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 18h.01M9.5 9.5a2.5 2.5 0 1 1 4.2 1.9c-.78.7-1.2 1.2-1.2 2.1" />
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
        <span>Help</span>
      </button>
      {canRegister && (
        <button
          type="button"
          data-testid="mobile-nav-register"
          data-active={active === "register" ? "true" : "false"}
          className={active === "register" ? "is-active" : ""}
          onClick={navigate(onRegisterClick)}
          aria-current={active === "register" ? "page" : undefined}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" />
            <path d="M5 21a7 7 0 0 1 14 0" />
          </svg>
          <span>Register</span>
        </button>
      )}
    </nav>
  );
}

export default MobileNav;
