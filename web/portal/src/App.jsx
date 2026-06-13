import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useState } from 'react';
import LookupPage from './pages/LookupPage';
import SelectItemsPage from './pages/SelectItemsPage';
import ReturnReasonPage from './pages/ReturnReasonPage';
import ResolutionPage from './pages/ResolutionPage';
import DropoffPage from './pages/DropoffPage';
import ConfirmationPage from './pages/ConfirmationPage';
import PortalLayout from './components/PortalLayout';

export default function App() {
  const [returnData, setReturnData] = useState({
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
  });

  function updateReturnData(updates) {
    setReturnData((prev) => ({ ...prev, ...updates }));
  }

  return (
    <BrowserRouter>
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
        </Routes>
      </PortalLayout>
    </BrowserRouter>
  );
}
