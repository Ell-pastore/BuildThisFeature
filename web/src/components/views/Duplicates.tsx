import { Copy } from "../../components/Icons";

/**
 * Duplicate detection.
 *
 * Finding real duplicates requires hashing/scanning files beyond a single
 * directory listing, which isn't part of this release. This shows an honest
 * placeholder instead of the fabricated duplicate groups that used to come
 * from the demo data module.
 */
export default function Duplicates() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Copy size={16} className="text-purple-500" />
            <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Duplicate Detection</h1>
          </div>
          <p className="text-sm text-muted-foreground">Files that appear to be identical or near-identical copies.</p>
        </div>

        {/* Placeholder */}
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-14 h-14 rounded-2xl bg-purple-50 flex items-center justify-center mb-4">
            <Copy size={22} className="text-purple-500" />
          </div>
          <div className="text-sm font-medium text-foreground">Duplicate detection isn't available yet</div>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm leading-relaxed">
            Detecting duplicates requires hashing files across your drives, which isn't part of
            the current release. Real results will appear once file scanning is implemented —
            nothing is being invented here in the meantime.
          </p>
        </div>
      </div>
    </div>
  );
}