import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useState } from 'react';
import LookupPage from './pages/LookupPage';
import SelectItemsPage from './pages/SelectItemsPage';
import ReturnReasonPage from './pages/ReturnReasonPage';
import ResolutionPage from './pages/ResolutionPage';
import DropoffPage from './pages/DropoffPage';
import ConfirmationPage from './pages/ConfirmationPage';
import ReturnStatusPage from './pages/ReturnStatusPage';
import PortalLayout from './components/PortalLayout';
import { isDemo, DEMO_DATA } from './demoSeed';

const EMPTY_DATA = {
  shopId: null,
  shopName: '',
  shopSlug: '',
  order: null,
  selectedItems: [],
  reasons: {},
  photos: {},
  resolution: null,
  carrier: null,
  dropoff: null,
  returnResult: null,
};

export default function App() {
  // Seed mock data only when ?demo=1 is present (screenshots/demos); never in prod.
  const [returnData, setReturnData] = useState(isDemo() ? DEMO_DATA : EMPTY_DATA);

  function updateReturnData(updates) {
    setReturnData((prev) => ({ ...prev, ...updates }));
  }

  return (
    // basename="/portal" because Express serves this SPA at /portal/* — without it,
    // the router would try to match the full path including the prefix and never
    // hit any of the routes below.
    <BrowserRouter basename="/portal">
      <PortalLayout shopName={returnData.shopName}>
        <Routes>
          <Route
            path="/:shopSlug?"
            element={<LookupPage data={returnData} update={updateReturnData} />}
          />
          <Route
            path="/:shopSlug/select-items"
            element={<SelectItemsPage data={returnData} update={updateReturnData} />}
          />
          <Route
            path="/:shopSlug/reason"
            element={<ReturnReasonPage data={returnData} update={updateReturnData} />}
          />
          <Route
            path="/:shopSlug/resolution"
            element={<ResolutionPage data={returnData} update={updateReturnData} />}
          />
          <Route
            path="/:shopSlug/dropoff"
            element={<DropoffPage data={returnData} update={updateReturnData} />}
          />
          <Route
            path="/:shopSlug/confirmation"
            element={<ConfirmationPage data={returnData} />}
          />
          <Route
            path="/return/:id"
            element={<ReturnStatusPage />}
          />
        </Routes>
      </PortalLayout>
    </BrowserRouter>
  );
}
