import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import '@shopify/polaris/build/esm/styles.css';

import AppFrame from './components/AppFrame';
import DashboardPage from './pages/DashboardPage';
import ReturnsListPage from './pages/ReturnsListPage';
import ReturnDetailPage from './pages/ReturnDetailPage';
import PoliciesPage from './pages/PoliciesPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  return (
    <AppProvider i18n={enTranslations}>
      <BrowserRouter>
        <AppFrame>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/returns" element={<ReturnsListPage />} />
            <Route path="/returns/:id" element={<ReturnDetailPage />} />
            <Route path="/policies" element={<PoliciesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppFrame>
      </BrowserRouter>
    </AppProvider>
  );
}
