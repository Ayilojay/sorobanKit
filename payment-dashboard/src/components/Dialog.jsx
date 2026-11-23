import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
  );
}

/**
 * Reads the user's reduced-motion preference and keeps it in sync with
 * changes to the media query. Safe to use in SSR / non-browser environments.
 */
export function useReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQueryList = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = (event) => {
      setPrefersReducedMotion(event.matches);
    };

    setPrefersReducedMotion(mediaQueryList.matches);

    if (typeof mediaQueryList.addEventListener === 'function') {
      mediaQueryList.addEventListener('change', handleChange);
      return () => mediaQueryList.removeEventListener('change', handleChange);
    }

    // Legacy Safari / older browsers.
    if (typeof mediaQueryList.addListener === 'function') {
      mediaQueryList.addListener(handleChange);
      return () => mediaQueryList.removeListener(handleChange);
    }

    return undefined;
  }, []);

  return prefersReducedMotion;
}

const DialogContext = createContext(null);

export function useDialogContext() {
  return useContext(DialogContext);
}

/**
 * Reusable accessible dialog.
 *
 * - role="dialog" + aria-modal="true"
 * - Labelled via aria-labelledby (title) and aria-describedby (description)
 * - Moves focus into the dialog on open (initialFocusRef or first focusable)
 * - Traps Tab / Shift+Tab focus within the dialog
 * - Escape closes the dialog when closeOnEscape is true (default)
 * - Returns focus to the previously focused element (the trigger) on close
 */
export default function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  initialFocusRef,
  closeOnEscape = true,
  closeOnBackdropClick = true,
  className = '',
  overlayClassName = '',
  ariaLabel,
  ...rest
}) {
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const descriptionId = `${generatedId}-description`;

  const dialogRef = useRef(null);
  const previouslyFocusedRef = useRef(null);
  const prefersReducedMotion = useReducedMotion();

  const requestClose = useCallback(
    (reason) => {
      if (typeof onClose === 'function') {
        onClose(reason);
      }
    },
    [onClose]
  );

  // Capture the trigger and move focus into the dialog when it opens.
  useLayoutEffect(() => {
    if (!open) return undefined;

    if (typeof document !== 'undefined') {
      previouslyFocusedRef.current = document.activeElement;
    }

    const dialogNode = dialogRef.current;
    if (!dialogNode) return undefined;

    const focusTarget =
      (initialFocusRef && initialFocusRef.current) ||
      getFocusableElements(dialogNode)[0] ||
      dialogNode;

    // Allow the node to be focusable as a fallback.
    if (focusTarget === dialogNode && !dialogNode.hasAttribute('tabindex')) {
      dialogNode.setAttribute('tabindex', '-1');
    }

    if (typeof focusTarget.focus === 'function') {
      focusTarget.focus({ preventScroll: true });
    }

    return () => {
      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open, initialFocusRef]);

  // Escape policy + focus trap.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' || event.key === 'Esc') {
        if (closeOnEscape) {
          event.stopPropagation();
          event.preventDefault();
          requestClose('escape');
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const dialogNode = dialogRef.current;
      if (!dialogNode) return;

      const focusable = getFocusableElements(dialogNode);

      if (focusable.length === 0) {
        event.preventDefault();
        if (typeof dialogNode.focus === 'function') {
          dialogNode.focus({ preventScroll: true });
        }
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || active === dialogNode || !dialogNode.contains(active)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last || !dialogNode.contains(active)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, closeOnEscape, requestClose]);

  // Prevent background scroll while the dialog is open.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [open]);

  const handleOverlayMouseDown = (event) => {
    if (!closeOnBackdropClick) return;
    if (event.target === event.currentTarget) {
      requestClose('backdrop');
    }
  };

  if (!open) return null;

  const hasTitle = Boolean(title);
  const hasDescription = Boolean(description);

  const contextValue = {
    titleId,
    descriptionId,
    requestClose,
    prefersReducedMotion,
  };

  const overlayStyle = prefersReducedMotion
    ? { transition: 'none', animation: 'none' }
    : undefined;

  const dialogStyle = prefersReducedMotion
    ? { transition: 'none', animation: 'none' }
    : undefined;

  return (
    <DialogContext.Provider value={contextValue}>
      <div
        className={`dialog-overlay ${overlayClassName}`.trim()}
        data-testid="dialog-overlay"
        data-reduced-motion={prefersReducedMotion ? 'true' : 'false'}
        style={overlayStyle}
        onMouseDown={handleOverlayMouseDown}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={hasTitle ? titleId : undefined}
          aria-describedby={hasDescription ? descriptionId : undefined}
          aria-label={!hasTitle ? ariaLabel : undefined}
          className={`dialog ${className}`.trim()}
          data-testid="dialog"
          data-reduced-motion={prefersReducedMotion ? 'true' : 'false'}
          style={dialogStyle}
          {...rest}
        >
          {hasTitle && (
            <h2 id={titleId} className="dialog__title" data-testid="dialog-title">
              {title}
            </h2>
          )}
          {hasDescription && (
            <p id={descriptionId} className="dialog__description" data-testid="dialog-description">
              {description}
            </p>
          )}
          <div className="dialog__content">{children}</div>
        </div>
      </div>
    </DialogContext.Provider>
  );
}