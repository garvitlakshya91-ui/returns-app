import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Search, AlertCircle } from 'lucide-react';
import ProgressStepper from '../components/ProgressStepper';
import DropoffMap from '../components/DropoffMap';
import { getDropoffLocations } from '../api';

export default function DropoffPage({ data, update }) {
  const { shopSlug } = useParams();
  const navigate = useNavigate();
  const [postcode, setPostcode] = useState('');
  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState(data.dropoff || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [carrier] = useState('evri');

  async function handleSearch(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await getDropoffLocations(data.shopId, carrier, postcode);
      const list = result.locations || [];
      setLocations(list);
      if (list.length === 0) {
        setError('No drop-off points found for this postcode. Try a different postcode.');
      }
    } catch (err) {
      setError('Could not load drop-off locations. Please try again.');
      setLocations([]);
    } finally {
      setLoading(false);
    }
  }

  function handleNext() {
    update({ carrier, dropoff: selected });
    navigate(`/${shopSlug}/confirmation`);
  }

  return (
    <div>
      <ProgressStepper currentStep={5} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Choose Drop-off Point</h1>
        <p className="text-gray-500 mt-1">Find your nearest drop-off location</p>
      </div>

      <div className="inline-flex items-center gap-2 bg-white border border-gray-200 rounded-full px-3 py-1.5 mb-4">
        <div className="w-4 h-4 bg-indigo-600 rounded-full" />
        <span className="text-sm font-medium text-gray-700 capitalize">{carrier}</span>
      </div>

      <form onSubmit={handleSearch} className="flex gap-2 mb-6">
        <input
          type="text"
          value={postcode}
          onChange={(e) => setPostcode(e.target.value)}
          placeholder="Enter postcode (e.g. GL1 1DQ)"
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-sm"
        />
        <button
          type="submit"
          disabled={!postcode.trim() || loading}
          className="px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
        >
          {loading ? (
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          <span className="text-sm">Search</span>
        </button>
      </form>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700 text-sm mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="mb-8">
        <DropoffMap locations={locations} selected={selected} onSelect={setSelected} />
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => navigate(`/${shopSlug}/resolution`)}
          className="flex-1 py-3 px-4 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={!selected}
          className="flex-1 py-3 px-4 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
