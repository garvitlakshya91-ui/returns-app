import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import ProgressStepper from '../components/ProgressStepper';
import OrderItemCard from '../components/OrderItemCard';

export default function SelectItemsPage({ data, update }) {
  const { shopSlug } = useParams();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(data.selectedItems || []);

  const items = data.order?.eligibleItems || [];

  // Guard: if the user lands here without going through lookup, send them back
  if (!data.order || items.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 mb-4">
          {!data.order ? 'Please look up your order first.' : 'No items in this order are eligible for return.'}
        </p>
        <button
          type="button"
          onClick={() => navigate(`/${shopSlug || ''}`)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          Back to lookup
        </button>
      </div>
    );
  }

  function toggleItem(item) {
    setSelected((prev) => {
      const exists = prev.find((s) => s.id === item.id);
      if (exists) return prev.filter((s) => s.id !== item.id);
      return [...prev, item];
    });
  }

  function handleNext() {
    update({ selectedItems: selected });
    navigate(`/${shopSlug}/reason`);
  }

  return (
    <div>
      <ProgressStepper currentStep={2} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Select Items to Return</h1>
        <p className="text-gray-500 mt-1">
          Choose which items you'd like to return from order {data.order?.orderName || '#1001'}
        </p>
      </div>

      <div className="space-y-3 mb-8">
        {items.map((item) => (
          <OrderItemCard
            key={item.id}
            item={item}
            selected={selected.some((s) => s.id === item.id)}
            onToggle={toggleItem}
          />
        ))}
      </div>

      {selected.length > 0 && (
        <div className="bg-gray-50 rounded-lg p-3 mb-6 text-sm text-gray-600">
          <span className="font-medium text-gray-900">{selected.length} item{selected.length !== 1 ? 's' : ''}</span>
          {' '}selected — Total: {'\u00A3'}{selected.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0).toFixed(2)}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => navigate(`/${shopSlug || ''}`)}
          className="flex-1 py-3 px-4 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={selected.length === 0}
          className="flex-1 py-3 px-4 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
