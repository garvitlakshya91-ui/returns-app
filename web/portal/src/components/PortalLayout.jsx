import { Package, ShieldCheck } from 'lucide-react';

export default function PortalLayout({ shopName, children }) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-gray-200/70">
        <div className="max-w-lg mx-auto flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-sm shadow-indigo-600/30">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div className="leading-tight">
            <span className="block font-semibold text-[15px] text-gray-900">
              {shopName || 'Returns'}
            </span>
            <span className="block text-xs text-gray-400">Returns &amp; Exchanges</span>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 px-4 py-7">
        <div className="max-w-lg mx-auto">
          {children}
        </div>
      </main>

      {/* Footer */}
      <footer className="px-4 py-5">
        <div className="max-w-lg mx-auto flex items-center justify-center gap-1.5 text-xs text-gray-400">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Secure returns powered by ReturnFlow</span>
        </div>
      </footer>
    </div>
  );
}
