import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, Spinner } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import '@shopify/polaris/build/esm/styles.css';

import AppFrame from './components/AppFrame';

// Lazy-load every page so each one becomes its own chunk. Dashboard stays
// eager because it's the landing page and almost always navigated to first.
import DashboardPage from './pages/DashboardPage';
const ReturnsListPage  = lazy(() => import('./pages/ReturnsListPage'));
const ReturnDetailPage = lazy(() => import('./pages/ReturnDetailPage'));
const AnalyticsPage    = lazy(() => import('./pages/AnalyticsPage'));
const PoliciesPage     = lazy(() => import('./pages/PoliciesPage'));
const SettingsPage     = lazy(() => import('./pages/SettingsPage'));

function PageLoader() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
      <Spinner size="large" />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider i18n={enTranslations}>
      <BrowserRouter>
        <AppFrame>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/returns" element={<ReturnsListPage />} />
              <Route path="/returns/:id" element={<ReturnDetailPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/policies" element={<PoliciesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AppFrame>
      </BrowserRouter>
    </AppProvider>
  );
}
