import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search, AlertCircle } from 'lucide-react';
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

      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Start a Return</h1>
        <p className="text-gray-500 mt-1">Enter your details to find your order</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-shadow"
          />
        </div>

        <div>
          <label htmlFor="order" className="block text-sm font-medium text-gray-700 mb-1">
            Order number
          </label>
          <input
            id="order"
            type="text"
            required
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="#1001"
            className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-shadow"
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 px-4 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {loading ? (
            <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Search className="w-4 h-4" />
              Find My Order
            </>
          )}
        </button>
      </form>
    </div>
  );
}
