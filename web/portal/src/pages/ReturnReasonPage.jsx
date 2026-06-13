import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import ProgressStepper from '../components/ProgressStepper';
import PhotoUploader from '../components/PhotoUploader';

const RETURN_REASONS = [
  { value: 'doesnt_fit', label: "Doesn't fit" },
  { value: 'changed_mind', label: 'Changed my mind' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'wrong_item', label: 'Wrong item received' },
  { value: 'quality', label: 'Quality not as expected' },
  { value: 'other', label: 'Other' },
];

export default function ReturnReasonPage({ data, update }) {
  const { shopSlug } = useParams();
  const navigate = useNavigate();
  const [reasons, setReasons] = useState(data.reasons || {});
  const [photos, setPhotos] = useState(data.photos || {});

  const items = data.selectedItems || [];

  function setItemReason(itemId, reason) {
    setReasons((prev) => ({ ...prev, [itemId]: { ...prev[itemId], reason } }));
  }

  function setItemDetail(itemId, detail) {
    setReasons((prev) => ({ ...prev, [itemId]: { ...prev[itemId], detail } }));
  }

  function setItemPhotos(itemId, itemPhotos) {
    setPhotos((prev) => ({ ...prev, [itemId]: itemPhotos }));
  }

  const allReasoned = items.every((item) => reasons[item.id]?.reason);

  function handleNext() {
    update({ reasons, photos });
    navigate(`/${shopSlug}/resolution`);
  }

  return (
    <div>
      <ProgressStepper currentStep={3} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Return Reason</h1>
        <p className="text-gray-500 mt-1">Tell us why you're returning each item</p>
      </div>

      <div className="space-y-6 mb-8">
        {items.map((item) => (
          <div key={item.id} className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs shrink-0">
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.title} className="w-full h-full object-cover rounded" />
                ) : 'Img'}
              </div>
              <div>
                <p className="font-medium text-gray-900 text-sm">{item.title}</p>
                {item.variantTitle && <p className="text-xs text-gray-500">{item.variantTitle}</p>}
              </div>
            </div>

            {/* Reason selector */}
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Reason for return
            </label>
            <select
              value={reasons[item.id]?.reason || ''}
              onChange={(e) => setItemReason(item.id, e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-300 bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-sm mb-3"
            >
              <option value="">Select a reason...</option>
              {RETURN_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>

            {/* Additional details */}
            {reasons[item.id]?.reason && (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Additional details (optional)
                </label>
                <textarea
                  value={reasons[item.id]?.detail || ''}
                  onChange={(e) => setItemDetail(item.id, e.target.value)}
                  placeholder="Any extra information..."
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-sm mb-3 resize-none"
                />

                {/* Photo upload */}
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Photos (optional)
                </label>
                <PhotoUploader
                  photos={photos[item.id] || []}
                  onChange={(p) => setItemPhotos(item.id, p)}
                />
              </>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => navigate(`/${shopSlug}/select-items`)}
          className="flex-1 py-3 px-4 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={!allReasoned}
          className="flex-1 py-3 px-4 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
