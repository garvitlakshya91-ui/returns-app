import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle, AlertCircle, Loader2, Package } from 'lucide-react';
import { getReturnStatus } from '../api';

const STATUS_COPY = {
  REQUESTED: 'We\'ve received your return and are reviewing it.',
  APPROVED: 'Your return has been approved. Your shipping label is on its way.',
  LABEL_SENT: 'Your shipping label is ready — check your email.',
  IN_TRANSIT: 'Your return is on its way back to the store.',
  RECEIVED: 'We\'ve received your parcel and are inspecting it.',
  INSPECTING: 'Your items are being inspected.',
  PROCESSED: 'Your return has been processed. Refund details are below.',
  REJECTED: 'Your return request could not be approved.',
  CANCELLED: 'This return was cancelled.',
};

export default function ReturnStatusPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const paid = searchParams.get('paid');

  const [ret, setReturn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getReturnStatus(id);
        if (!cancelled) setReturn(data);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load return');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p>Loading your return...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Couldn't load return</h1>
        <p className="text-gray-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="py-2">
      {paid === '1' && (
        <div className="mb-6 p-4 rounded-lg bg-green-50 border border-green-200 flex items-start gap-3">
          <CheckCircle className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-green-900">Payment received</p>
            <p className="text-sm text-green-700 mt-0.5">
              Thanks — we'll email you your return label shortly.
            </p>
          </div>
        </div>
      )}

      {paid === '0' && (
        <div className="mb-6 p-4 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-amber-900">Payment not completed</p>
            <p className="text-sm text-amber-700 mt-0.5">
              Your return is on hold until the fee is paid.
            </p>
          </div>
        </div>
      )}

      <div className="text-center mb-6">
        <Package className="w-10 h-10 text-indigo-600 mx-auto mb-2" />
        <h1 className="text-2xl font-bold text-gray-900">Return {ret.id?.slice(0, 8)}</h1>
        <p className="text-gray-500 mt-1">{STATUS_COPY[ret.status] || ret.status}</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-gray-500">Status</span>
          <span className="font-medium text-gray-900">{ret.status}</span>
        </div>
        {ret.resolution && (
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-gray-500">Resolution</span>
            <span className="font-medium text-gray-900">{ret.resolution}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-gray-500">Total value</span>
          <span className="font-medium text-gray-900">
            {'£'}{Number(ret.totalValue || 0).toFixed(2)}
          </span>
        </div>
        {ret.refundAmount != null && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Refund amount</span>
            <span className="font-medium text-gray-900">
              {'£'}{Number(ret.refundAmount).toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {ret.label?.trackingCode && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 text-sm">
          <p className="font-medium text-indigo-900 mb-1">Shipping label</p>
          <p className="text-indigo-700">
            Carrier: <strong>{ret.label.carrier}</strong>
          </p>
          <p className="text-indigo-700">
            Tracking: <strong>{ret.label.trackingCode}</strong>
          </p>
        </div>
      )}
    </div>
  );
}
