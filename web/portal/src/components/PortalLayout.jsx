import { Package, ShieldCheck } from 'lucide-react';

export default function PortalLayout({ shopName, branding, children }) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-gray-200/70">
        <div className="max-w-lg mx-auto flex items-center gap-3 px-4 py-3">
          {branding?.logoUrl ? (
            <img src={branding.logoUrl} alt={shopName || 'Store logo'} className="h-9 max-w-[140px] object-contain" />
          ) : (
            <div className="w-9 h-9 rounded-xl brand-bg flex items-center justify-center shadow-sm">
              <Package className="w-5 h-5 text-white" />
            </div>
          )}
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
        {branding?.supportEmail && (
          <p className="max-w-lg mx-auto text-center text-xs text-gray-400 mt-2">
            Need help? <a className="underline" href={`mailto:${branding.supportEmail}`}>{branding.supportEmail}</a>
          </p>
        )}
      </footer>
    </div>
  );
}
