import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle, Package, MapPin, CreditCard, Loader2 } from 'lucide-react';
import ProgressStepper from '../components/ProgressStepper';
import { createReturn } from '../api';

const RESOLUTION_LABELS = {
  REFUND: 'Refund to original payment',
  STORE_CREDIT: 'Store credit (gift card)',
  EXCHANGE: 'Exchange',
};

const REASON_LABELS = {
  doesnt_fit: "Doesn't fit",
  changed_mind: 'Changed my mind',
  not_as_described: 'Not as described',
  damaged: 'Arrived damaged',
  wrong_item: 'Wrong item received',
  quality: 'Quality not as expected',
  other: 'Other',
};

export default function ConfirmationPage({ data }) {
  const { shopSlug } = useParams();
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(data.returnResult);

  const items = data.selectedItems || [];
  const totalValue = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);

  async function handleSubmit() {
    setLoading(true);
    setError('');

    try {
      const returnResult = await createReturn({
        shopId: data.shopId,
        shopSlug,
        customerEmail: data.order?.email,
        items: items.map((item) => ({
          lineItemId: item.lineItemId,
          productId: item.productId,
          variantId: item.variantId,
          productTitle: item.title,
          variantTitle: item.variantTitle,
          sku: item.sku,
          quantity: item.quantity,
          unitPrice: item.price,
          reason: data.reasons?.[item.id]?.reason,
          reasonDetail: data.reasons?.[item.id]?.detail,
          photoUrls: [],
        })),
        resolution: data.resolution,
        carrier: data.carrier,
        dropoff: data.dropoff,
      });

      setResult(returnResult);
      setSubmitted(true);
    } catch (err) {
      setError(err.message || 'Failed to submit return. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (submitted && result) {
    return (
      <div>
        <ProgressStepper currentStep={6} />

        <div className="text-center py-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle className="w-9 h-9 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Return submitted</h1>
          <p className="text-gray-500 mb-6 max-w-xs mx-auto">
            We've received your request. You'll get an email with your shipping label shortly.
          </p>

          <div className="card p-4 text-left mb-6">
            <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Return reference</p>
            <p className="font-mono text-lg font-semibold text-gray-900">{result.id || 'RF-PENDING'}</p>
          </div>

          {Number(result.returnFee || 0) > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-left text-sm mb-6">
              <p className="font-medium text-amber-900">
                {'£'}{Number(result.returnFee).toFixed(2)} return fee
              </p>
              <p className="text-amber-700 mt-0.5">
                {data.resolution === 'EXCHANGE'
                  ? 'This will be added to your exchange order at checkout.'
                  : 'This will be deducted from your refund — you don’t pay anything now.'}
              </p>
            </div>
          )}

          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 text-left text-sm">
            <p className="font-medium text-indigo-900 mb-1">What happens next?</p>
            <ol className="text-indigo-700 space-y-1 list-decimal list-inside">
              <li>We'll review your return (usually within 24 hours)</li>
              <li>You'll receive a QR code / shipping label via email</li>
              <li>Drop off your parcel at your chosen location</li>
              <li>Refund processed once we receive your items</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ProgressStepper currentStep={6} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Review & Confirm</h1>
        <p className="text-gray-500 mt-1">Please review your return details before submitting</p>
      </div>

      {/* Items summary */}
      <div className="card p-4 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <Package className="w-4 h-4" />
          Items ({items.length})
        </h2>
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between text-sm">
              <div>
                <p className="text-gray-900">{item.title}</p>
                <p className="text-gray-400 text-xs">
                  {item.variantTitle} — {REASON_LABELS[data.reasons?.[item.id]?.reason] || 'No reason'}
                </p>
              </div>
              <span className="font-medium text-gray-900">{'\u00A3'}{Number(item.price).toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-gray-100 mt-3 pt-3 flex items-center justify-between font-medium">
          <span>Total return value</span>
          <span>{'\u00A3'}{totalValue.toFixed(2)}</span>
        </div>
      </div>

      {/* Resolution */}
      <div className="card p-4 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
          <CreditCard className="w-4 h-4" />
          Resolution
        </h2>
        <p className="text-sm text-gray-900">{RESOLUTION_LABELS[data.resolution] || data.resolution}</p>
      </div>

      {/* Drop-off */}
      {data.dropoff && (
        <div className="card p-4 mb-8">
          <h2 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
            <MapPin className="w-4 h-4" />
            Drop-off location
          </h2>
          <p className="text-sm text-gray-900">{data.dropoff.name}</p>
          <p className="text-xs text-gray-500">{data.dropoff.address}</p>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading}
        className="btn-primary"
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Submitting...
          </>
        ) : (
          <>
            <CheckCircle className="w-5 h-5" />
            Submit Return
          </>
        )}
      </button>
    </div>
  );
}
