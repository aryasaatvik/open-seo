import { GoogleGlyph } from "@/client/features/gsc/GoogleGlyph";
import { startGoogleConnect } from "@/client/features/integrations/googleConnect";

type PropertyOption = {
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
  isSelected: boolean;
};

type SecondaryAction = {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

export function Ga4PropertyPicker({
  loading,
  error,
  requiresReconnect,
  propertiesUnavailable,
  email,
  properties,
  selection,
  onSelect,
  onSave,
  saving,
  onRetry,
  secondaryAction,
}: {
  loading: boolean;
  error: boolean;
  requiresReconnect: boolean;
  propertiesUnavailable: boolean;
  email: string | null;
  properties: PropertyOption[];
  selection: string | null;
  onSelect: (propertyId: string) => void;
  onSave: () => void;
  saving: boolean;
  onRetry: () => void;
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
          Couldn&rsquo;t load your Google Analytics properties.
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onRetry}
          >
            Try again
          </button>
          {secondaryAction ? (
            <SecondaryActionButton action={secondaryAction} />
          ) : null}
        </div>
      </div>
    );
  }

  if (requiresReconnect) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-error">
          Connection expired. Reconnect to continue.
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <GoogleConnectButton
            label="Reconnect with Google"
            onClick={() => startGoogleConnect("ga4")}
          />
          {secondaryAction ? (
            <SecondaryActionButton action={secondaryAction} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {propertiesUnavailable ? (
        <p className="text-sm text-warning">
          Properties couldn&rsquo;t be loaded. Check that the Analytics Admin
          API is enabled and that this Google account has property access.
        </p>
      ) : null}
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
            {properties.length === 0 ? (
              <option disabled>No properties</option>
            ) : (
              properties.map((property) => (
                <option key={property.propertyId} value={property.propertyId}>
                  {property.accountDisplayName} · {property.displayName}
                </option>
              ))
            )}
          </optgroup>
        </select>
      </label>
      {properties.length === 0 && !propertiesUnavailable ? (
        <p className="text-sm text-base-content/60">
          No Google Analytics properties are available for this account.
        </p>
      ) : null}
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
          onClick={() => startGoogleConnect("ga4")}
        >
          Use a different Google account
        </button>
        {secondaryAction ? (
          <SecondaryActionButton action={secondaryAction} />
        ) : null}
      </div>
    </div>
  );
}

function SecondaryActionButton({ action }: { action: SecondaryAction }) {
  return (
    <button
      type="button"
      className={[
        "btn btn-ghost btn-sm",
        action.destructive ? "text-error hover:bg-error/10" : "",
      ].join(" ")}
      onClick={action.onClick}
      disabled={action.disabled}
    >
      {action.label}
    </button>
  );
}

function GoogleConnectButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2.5 rounded-lg border border-base-300 bg-base-100 px-4 py-2.5 text-sm font-semibold shadow-sm transition hover:bg-base-200"
    >
      <GoogleGlyph className="size-[18px]" />
      {label}
    </button>
  );
}
