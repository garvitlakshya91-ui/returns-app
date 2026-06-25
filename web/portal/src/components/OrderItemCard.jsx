import { Check } from 'lucide-react';

export default function OrderItemCard({ item, selected, onToggle, disabled }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onToggle(item)}
      disabled={disabled}
      aria-pressed={selected}
      className={`option-card ${selected ? 'option-card-active' : 'option-card-idle'}
        ${disabled ? 'opacity-50 !cursor-not-allowed' : ''}`}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox indicator */}
        <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center mt-0.5 shrink-0 transition-colors
          ${selected ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300 bg-white'}
        `}>
          {selected && <Check className="w-3 h-3 text-white" />}
        </div>

        {/* Product image */}
        {item.imageUrl ? (
          <img src={item.imageUrl} alt={item.title} className="w-16 h-16 object-cover rounded-xl border border-gray-200 shrink-0" />
        ) : (
          <div className="w-16 h-16 bg-gray-100 rounded-xl flex items-center justify-center text-gray-400 text-[11px] shrink-0">
            No image
          </div>
        )}

        {/* Product details */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900 truncate">{item.title}</p>
          {item.variantTitle && (
            <p className="text-sm text-gray-500 truncate">{item.variantTitle}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-sm font-semibold text-gray-900">
              {'£'}{Number(item.price).toFixed(2)}
            </span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-sm text-gray-400">Qty {item.quantity}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
