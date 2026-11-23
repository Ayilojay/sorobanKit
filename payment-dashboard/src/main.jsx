import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { LiveAnnouncer } from './a11y/focusManager.jsx'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <LiveAnnouncer>
        <App />
      </LiveAnnouncer>
    </ErrorBoundary>
  </StrictMode>,
)