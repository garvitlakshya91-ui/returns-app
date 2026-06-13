import { Check } from 'lucide-react';

export default function OrderItemCard({ item, selected, onToggle, disabled }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onToggle(item)}
      disabled={disabled}
      className={`w-full text-left p-4 rounded-lg border-2 transition-all
        ${selected
          ? 'border-indigo-600 bg-indigo-50'
          : 'border-gray-200 bg-white hover:border-gray-300'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox indicator */}
        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center mt-0.5 shrink-0
          ${selected ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'}
        `}>
          {selected && <Check className="w-3 h-3 text-white" />}
        </div>

        {/* Product image placeholder */}
        {item.imageUrl ? (
          <img src={item.imageUrl} alt={item.title} className="w-16 h-16 object-cover rounded" />
        ) : (
          <div className="w-16 h-16 bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs shrink-0">
            No img
          </div>
        )}

        {/* Product details */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900 truncate">{item.title}</p>
          {item.variantTitle && (
            <p className="text-sm text-gray-500">{item.variantTitle}</p>
          )}
          <div className="flex items-center gap-3 mt-1">
            <span className="text-sm font-medium text-gray-900">
              {'\u00A3'}{Number(item.price).toFixed(2)}
            </span>
            <span className="text-sm text-gray-400">Qty: {item.quantity}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
