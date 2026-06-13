import { Package } from 'lucide-react';

export default function PortalLayout({ shopName, children }) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center gap-2">
          <Package className="w-6 h-6 text-indigo-600" />
          <span className="font-semibold text-lg text-gray-900">
            {shopName || 'ReturnFlow'}
          </span>
          <span className="text-sm text-gray-400 ml-1">Returns</span>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 px-4 py-6">
        <div className="max-w-lg mx-auto">
          {children}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 px-4 py-3 text-center">
        <p className="text-xs text-gray-400">
          Powered by ReturnFlow
        </p>
      </footer>
    </div>
  );
}
