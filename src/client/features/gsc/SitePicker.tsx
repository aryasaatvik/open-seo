import { GoogleGlyph } from "@/client/features/gsc/GoogleGlyph";

type SiteOption = {
  siteUrl: string;
  permissionLevel: string;
  selectable: boolean;
  isSelected: boolean;
};

type SecondaryAction = {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

/**
 * Verified-property selector for the connected Google account. Shared by the
 * Integrations card and the onboarding step. `secondaryAction` is optional —
 * omit it where there's nothing to cancel/disconnect (e.g. onboarding).
 */
export function SitePicker({
  loading,
  error,
  requiresReconnect,
  email,
  sites,
  selection,
  onSelect,
  onSave,
  saving,
  onRetry,
  onReconnect,
  secondaryAction,
}: {
  loading: boolean;
  error: boolean;
  requiresReconnect: boolean;
  email: string | null;
  sites: SiteOption[];
  selection: string | null;
  onSelect: (siteUrl: string) => void;
  onSave: () => void;
  saving: boolean;
  onRetry: () => void;
  onReconnect: () => void;
  secondaryAction?: SecondaryAction;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-base-content/50">
        <span className="loading loading-spinner loading-sm" />
        Loading properties…
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-error">
          Couldn't load your Search Console properties.
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }

  if (requiresReconnect) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-error">
          Connection expired. Reconnect to continue.
        </p>
        <button
          type="button"
          onClick={onReconnect}
          className="inline-flex items-center gap-2.5 rounded-lg border border-base-300 bg-base-100 px-4 py-2.5 text-sm font-semibold shadow-sm transition hover:bg-base-200"
        >
          <GoogleGlyph className="size-[18px]" />
          Reconnect with Google
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-base-content/80">
          Property
        </span>
        <select
          className="select select-bordered w-full max-w-md"
          value={selection ?? ""}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="" disabled>
            Select a property…
          </option>
          <optgroup label={email ?? "Google account"}>
            {sites.length === 0 ? (
              <option disabled>No properties</option>
            ) : (
              sites.map((site) => (
                <option
                  key={site.siteUrl}
                  value={site.siteUrl}
                  disabled={!site.selectable}
                >
                  {site.siteUrl}
                  {site.selectable ? "" : "  (no access)"}
                </option>
              ))
            )}
          </optgroup>
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={!selection || saving}
        >
          {saving ? "Saving…" : "Save property"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onReconnect}
        >
          Use a different Google account
        </button>
        {secondaryAction ? (
          <button
            type="button"
            className={[
              "btn btn-ghost btn-sm",
              secondaryAction.destructive ? "text-error hover:bg-error/10" : "",
            ].join(" ")}
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
          >
            {secondaryAction.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
