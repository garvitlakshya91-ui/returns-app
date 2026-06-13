import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Banknote, CreditCard, RefreshCw } from 'lucide-react';
import ProgressStepper from '../components/ProgressStepper';

const RESOLUTIONS = [
  {
    value: 'REFUND',
    label: 'Refund to original payment',
    description: 'Money back to your original payment method. Usually takes 5-10 business days.',
    icon: Banknote,
  },
  {
    value: 'STORE_CREDIT',
    label: 'Store credit',
    description: 'Get a gift card for the full value. Available instantly via email.',
    icon: CreditCard,
    badge: 'Fastest',
  },
  {
    value: 'EXCHANGE',
    label: 'Exchange for another item',
    description: 'Swap for a different size, colour, or product.',
    icon: RefreshCw,
  },
];

export default function ResolutionPage({ data, update }) {
  const { shopSlug } = useParams();
  const navigate = useNavigate();
  const [resolution, setResolution] = useState(data.resolution || null);

  const totalValue = (data.selectedItems || []).reduce(
    (sum, item) => sum + Number(item.price) * item.quantity, 0
  );

  function handleNext() {
    update({ resolution });
    navigate(`/${shopSlug}/dropoff`);
  }

  return (
    <div>
      <ProgressStepper currentStep={4} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">How would you like to be refunded?</h1>
        <p className="text-gray-500 mt-1">
          Return value: <span className="font-semibold text-gray-900">{'\u00A3'}{totalValue.toFixed(2)}</span>
        </p>
      </div>

      <div className="space-y-3 mb-8">
        {RESOLUTIONS.map((res) => {
          const Icon = res.icon;
          const isSelected = resolution === res.value;

          return (
            <button
              key={res.value}
              type="button"
              onClick={() => setResolution(res.value)}
              className={`w-full text-left p-4 rounded-lg border-2 transition-all
                ${isSelected ? 'border-indigo-600 bg-indigo-50' : 'border-gray-200 bg-white hover:border-gray-300'}
              `}
            >
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0
                  ${isSelected ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500'}
                `}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-gray-900">{res.label}</p>
                    {res.badge && (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                        {res.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-0.5">{res.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => navigate(`/${shopSlug}/reason`)}
          className="flex-1 py-3 px-4 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={!resolution}
          className="flex-1 py-3 px-4 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
