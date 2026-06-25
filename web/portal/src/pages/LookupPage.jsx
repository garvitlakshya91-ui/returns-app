import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search, AlertCircle, Package } from 'lucide-react';
import ProgressStepper from '../components/ProgressStepper';
import { lookupOrder } from '../api';

export default function LookupPage({ data, update }) {
  const { shopSlug } = useParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const slug = shopSlug || data.shopSlug;
      if (!slug) {
        setError('Invalid shop URL');
        return;
      }

      const result = await lookupOrder(email, orderNumber, slug);
      update({
        shopId: result.shopId,
        shopName: result.shopName,
        shopSlug: slug,
        order: result,
      });
      navigate(`/${slug}/select-items`);
    } catch (err) {
      setError(err.message || 'Could not find your order. Please check your details.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <ProgressStepper currentStep={1} />

      <div className="text-center mb-7">
        <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-md shadow-indigo-600/25">
          <Package className="w-7 h-7 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Start a return</h1>
        <p className="text-gray-500 mt-1.5 max-w-xs mx-auto">
          Enter your email and order number to begin — it only takes a minute.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="card p-5 sm:p-6 space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="field"
          />
        </div>

        <div>
          <label htmlFor="order" className="block text-sm font-medium text-gray-700 mb-1.5">
            Order number
          </label>
          <input
            id="order"
            type="text"
            required
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="#1001"
            className="field"
          />
          <p className="text-xs text-gray-400 mt-1.5">
            You'll find this in your order confirmation email.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? (
            <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Search className="w-4 h-4" />
              Find my order
            </>
          )}
        </button>
      </form>
    </div>
  );
}
