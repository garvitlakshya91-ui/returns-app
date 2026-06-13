import { MapPin, Clock, Navigation } from 'lucide-react';

export default function DropoffMap({ locations = [], selected, onSelect }) {
  if (locations.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400">
        <MapPin className="w-8 h-8 mx-auto mb-2" />
        <p>Enter your postcode to find drop-off points</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {locations.map((loc) => (
        <button
          key={loc.id}
          type="button"
          onClick={() => onSelect(loc)}
          className={`w-full text-left p-4 rounded-lg border-2 transition-all
            ${selected?.id === loc.id
              ? 'border-indigo-600 bg-indigo-50'
              : 'border-gray-200 bg-white hover:border-gray-300'}
          `}
        >
          <div className="flex items-start gap-3">
            <MapPin className={`w-5 h-5 shrink-0 mt-0.5 ${selected?.id === loc.id ? 'text-indigo-600' : 'text-gray-400'}`} />
            <div className="flex-1">
              <p className="font-medium text-gray-900">{loc.name}</p>
              <p className="text-sm text-gray-500">{loc.address}</p>
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                <span className="flex items-center gap-1">
                  <Navigation className="w-3 h-3" />
                  {loc.distance}
                </span>
                {loc.openingHours && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {loc.openingHours}
                  </span>
                )}
              </div>
            </div>
            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full shrink-0">
              {loc.type}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
