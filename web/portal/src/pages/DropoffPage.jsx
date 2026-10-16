import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ExternalLink, MapPin, Mail } from 'lucide-react';
import ProgressStepper from '../components/ProgressStepper';

// No carrier location finder is wired up yet, so instead of a postcode search
// that could only show invented addresses, point customers to each carrier's
// official finder. The label names the carrier, and any of its drop-off points
// accepts the parcel. The step never blocks: Continue is always available.
const CARRIER_FINDERS = [
  {
    name: 'Royal Mail',
    detail: 'Post Offices, Parcel Postboxes and Customer Service Points',
    url: 'https://www.royalmail.com/services-near-you',
  },
  {
    name: 'Evri',
    detail: 'ParcelShops in local shops and supermarkets',
    url: 'https://www.evri.com/find-a-parcelshop',
  },
  {
    name: 'InPost',
    detail: '24/7 parcel lockers',
    url: 'https://inpost.co.uk/lockers',
  },
];

export default function DropoffPage({ update }) {
  const { shopSlug } = useParams();
  const navigate = useNavigate();

  function handleNext() {
    update({ carrier: null, dropoff: null });
    navigate(`/${shopSlug}/confirmation`);
  }

  return (
    <div>
      <ProgressStepper currentStep={5} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dropping off your parcel</h1>
        <p className="text-gray-500 mt-1">
          Your label shows which carrier to use. Any of that carrier&apos;s drop-off points will accept it.
        </p>
      </div>

      <div className="card p-4 mb-6 flex items-start gap-3">
        <Mail className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
        <p className="text-sm text-gray-700">
          Once the store approves your return, we&apos;ll email your label and QR code.
          Pack the item, then take it to a drop-off point near you.
        </p>
      </div>

      <h2 className="text-sm font-semibold text-gray-700 mb-3">Find a drop-off point</h2>
      <div className="space-y-3 mb-8">
        {CARRIER_FINDERS.map((c) => (
          <a
            key={c.name}
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="option-card option-card-idle flex items-start gap-3"
          >
            <MapPin className="w-5 h-5 shrink-0 mt-0.5 text-gray-400" />
            <div className="flex-1">
              <p className="font-medium text-gray-900">{c.name}</p>
              <p className="text-sm text-gray-500">{c.detail}</p>
            </div>
            <ExternalLink className="w-4 h-4 shrink-0 mt-1 text-gray-400" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ))}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => navigate(`/${shopSlug}/resolution`)}
          className="btn-secondary flex-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          type="button"
          onClick={handleNext}
          className="btn-primary flex-1"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
