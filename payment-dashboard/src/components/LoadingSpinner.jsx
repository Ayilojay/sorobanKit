/**
 * @param {{ size?: string, color?: string }} props
 */
export default function LoadingSpinner({ size = 'w-5 h-5', color = 'text-white' }) {
  return (
    <svg
      className={`motion-safe:animate-spin motion-reduce:animate-none ${size} ${color}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      role="status"
      aria-label="Loading"
    >
      <title>Loading</title>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  )
}