import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import { PosProvider, usePos } from './context/PosContext'
import { AppShell } from './shell/AppShell'
import SignIn from './pages/SignIn'
import Till from './pages/Till'
import Floor from './pages/Floor'
import Kitchen from './pages/Kitchen'
import OfflineQueue from './pages/OfflineQueue'
import Reports from './pages/Reports'
import Setup from './pages/Setup'
import Overview from './pages/dashboards/Overview'
import Retail from './pages/dashboards/Retail'
import Restaurant from './pages/dashboards/Restaurant'
import Customers from './pages/dashboards/Customers'
import Controls from './pages/dashboards/Controls'
import { ReturnDetail, ReturnsList } from './pages/Returns'
import { Notice } from './ui'
import { initAnalytics, trackPageView } from './utils/analytics'
import './App.css'
import './dashboards/styles.css'

initAnalytics()

function PageViews() {
  const location = useLocation()
  useEffect(() => {
    trackPageView(location.pathname, document.title)
  }, [location.pathname])

  return null
}

/**
 * Nothing renders until a company is chosen.
 *
 * Every endpoint in this API is company-scoped, so a screen without a scope
 * would be a screen full of 400s. Asking once, up front, is kinder than that.
 */
function RequireScope({ children }: { children: React.ReactNode }) {
  const { scope, session, loading, error } = usePos()

  if (!scope) {
    return (
      <Notice tone="info" title="Choose a company">
        Pick the company and financial year to work in, using the selector at the top of the page.
      </Notice>
    )
  }
  if (loading && !session) return <p style={{ color: 'var(--muted)' }}>Opening…</p>
  if (error) {
    return (
      <Notice tone="danger" title="Could not open that company">
        {error}
      </Notice>
    )
  }

  return <>{children}</>
}

export default function App() {
  const { status } = useAuth()

  if (status === 'signed-out') return <SignIn />

  if (status !== 'authenticated') {
    return (
      <main className="screen">
        <div className="panel">
          <p className="message">Signing you in…</p>
        </div>
      </main>
    )
  }

  return (
    <PosProvider>
      <BrowserRouter>
        <PageViews />
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<RequireScope><Till /></RequireScope>} />

            {/* The five dashboards. Each endpoint asserts its own permission, so
                a URL typed by someone who may not see it answers 403 rather than
                rendering an empty shell. */}
            <Route path="overview" element={<RequireScope><Overview /></RequireScope>} />
            <Route path="retail" element={<RequireScope><Retail /></RequireScope>} />
            <Route path="restaurant" element={<RequireScope><Restaurant /></RequireScope>} />
            <Route path="customers" element={<RequireScope><Customers /></RequireScope>} />
            <Route path="controls" element={<RequireScope><Controls /></RequireScope>} />

            <Route path="floor" element={<RequireScope><Floor /></RequireScope>} />
            <Route path="kitchen" element={<RequireScope><Kitchen /></RequireScope>} />
            <Route path="returns">
              <Route index element={<RequireScope><ReturnsList /></RequireScope>} />
              <Route path=":id" element={<RequireScope><ReturnDetail /></RequireScope>} />
            </Route>
            <Route path="offline" element={<RequireScope><OfflineQueue /></RequireScope>} />
            <Route path="reports" element={<RequireScope><Reports /></RequireScope>} />
            <Route path="setup" element={<RequireScope><Setup /></RequireScope>} />
            {/* The portal callback lands here once AuthProvider has consumed the token. */}
            <Route path="auth/callback" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Notice tone="warning">That page does not exist.</Notice>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PosProvider>
  )
}
