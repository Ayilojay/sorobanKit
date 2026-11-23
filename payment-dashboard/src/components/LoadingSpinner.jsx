/**
 * Accessible loading spinner.
 *
 * Renders a spinning SVG with `role="status"` and `aria-live="polite"` so
 * assistive technologies announce the loading state. An optional visible
 * `label` can be rendered alongside the spinner; when omitted, an
 * `aria-label` (defaulting to "Loading") is used so the status region is
 * always named.
 *
 * @param {{
 *   size?: string,
 *   color?: string,
 *   label?: string,
 *   labelClassName?: string,
 *   ariaLabel?: string,
 *   className?: string,
 * }} props
 */
export default function LoadingSpinner({
  size = 'w-5 h-5',
  color = 'text-white',
  label,
  labelClassName = '',
  ariaLabel,
  className = '',
}) {
  const accessibleName = ariaLabel || label || 'Loading'

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={accessibleName}
      className={`inline-flex items-center gap-2 ${className}`.trim()}
    >
      <svg
        className={`animate-spin ${size} ${color}`}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
      </svg>
      {label ? <span className={labelClassName}>{label}</span> : null}
    </span>
  )
}