import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ga4PropertyPicker } from "@/client/features/ga4/Ga4PropertyPicker";
import { GoogleGlyph } from "@/client/features/gsc/GoogleGlyph";
import { GoogleLinkErrorAlert } from "@/client/features/integrations/GoogleLinkErrorAlert";
import { IntegrationConnectionCard } from "@/client/features/integrations/IntegrationConnectionCard";
import { GoogleAnalyticsLogo } from "@/client/features/integrations/GoogleProductLogos";
import { startGoogleConnect } from "@/client/features/integrations/googleConnect";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { captureClientEvent } from "@/client/lib/posthog";
import {
  disconnectGa4,
  getGa4Connection,
  listGa4Properties,
  setGa4Property,
} from "@/serverFunctions/ga4";

const GOOGLE_STATUS_KEY = ["googleConnectionStatus"];

export function GoogleAnalyticsConnectionCard({
  projectId,
  onDismiss,
  dismissing = false,
  heading,
}: {
  projectId: string;
  onDismiss?: () => void;
  dismissing?: boolean;
  heading?: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [picking, setPicking] = React.useState(false);
  const [selection, setSelection] = React.useState<string | null>(null);
  const connectionKey = ["ga4Connection", projectId];
  const connectionQuery = useQuery({
    queryKey: connectionKey,
    queryFn: () => getGa4Connection({ data: { projectId } }),
  });
  const connection = connectionQuery.data;
  const connected = Boolean(connection?.connected);
  const showPicker = picking || (connection?.googleConnected && !connected);
  const propertiesQuery = useQuery({
    queryKey: ["ga4Properties", projectId],
    queryFn: () => listGa4Properties({ data: { projectId } }),
    enabled: Boolean(showPicker),
  });
  const properties = React.useMemo(
    () => propertiesQuery.data?.properties ?? [],
    [propertiesQuery.data?.properties],
  );

  React.useEffect(() => {
    if (selection) return;
    const selectedProperty = properties.find((property) => property.isSelected);
    if (selectedProperty) setSelection(selectedProperty.propertyId);
  }, [properties, selection]);

  const invalidateConnectionState = () => {
    void queryClient.invalidateQueries({ queryKey: connectionKey });
    void queryClient.invalidateQueries({ queryKey: GOOGLE_STATUS_KEY });
    void queryClient.invalidateQueries({
      queryKey: ["dashboardActivation", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["dashboardGa4Report", projectId],
    });
  };
  const setPropertyMutation = useMutation({
    mutationFn: (propertyId: string) =>
      setGa4Property({ data: { projectId, propertyId } }),
    onSuccess: () => {
      captureClientEvent("ga4:property_select");
      toast.success("Google Analytics connected");
      setPicking(false);
      invalidateConnectionState();
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const disconnectMutation = useMutation({
    mutationFn: () => disconnectGa4({ data: { projectId } }),
    onSuccess: () => {
      toast.success("Google Analytics disconnected");
      setPicking(false);
      setSelection(null);
      invalidateConnectionState();
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const handleConnect = () => startGoogleConnect("ga4");

  return (
    <>
      {heading}
      <IntegrationConnectionCard
        title="Google Analytics"
        icon={<GoogleAnalyticsLogo className="size-5" />}
        status={
          connectionQuery.isLoading
            ? undefined
            : connected
              ? "connected"
              : "disconnected"
        }
      >
        <GoogleLinkErrorAlert provider="ga4" className="mb-4" />
        {connectionQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-base-content/50">
            <span className="loading loading-spinner loading-sm" />
            Checking…
          </div>
        ) : connected && !picking ? (
          <ConnectedState
            displayName={connection?.propertyDisplayName ?? ""}
            propertyId={connection?.propertyId ?? ""}
            timeZone={connection?.propertyTimeZone ?? ""}
            currencyCode={connection?.propertyCurrencyCode ?? ""}
            connectedByEmail={connection?.connectedByEmail ?? null}
            onChange={() => {
              setSelection(null);
              setPicking(true);
            }}
            onDisconnect={() => disconnectMutation.mutate()}
            disconnecting={disconnectMutation.isPending}
          />
        ) : showPicker ? (
          <Ga4PropertyPicker
            loading={propertiesQuery.isLoading}
            error={propertiesQuery.isError}
            requiresReconnect={Boolean(propertiesQuery.data?.requiresReconnect)}
            propertiesUnavailable={Boolean(
              propertiesQuery.data?.propertiesUnavailable,
            )}
            email={propertiesQuery.data?.email ?? null}
            properties={properties}
            selection={selection}
            onSelect={setSelection}
            onSave={() => selection && setPropertyMutation.mutate(selection)}
            saving={setPropertyMutation.isPending}
            onRetry={() => void propertiesQuery.refetch()}
            secondaryAction={
              connected
                ? { label: "Cancel", onClick: () => setPicking(false) }
                : onDismiss
                  ? {
                      label: "Dismiss",
                      disabled: dismissing,
                      onClick: onDismiss,
                    }
                  : {
                      label: "Disconnect",
                      destructive: true,
                      disabled: disconnectMutation.isPending,
                      onClick: () => disconnectMutation.mutate(),
                    }
            }
          />
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-base-content/70">
              Connect GA4 to understand what organic visitors do after they land
              on your site.
            </p>
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={handleConnect}
                className="inline-flex items-center gap-2.5 rounded-lg border border-base-300 bg-base-100 px-4 py-2.5 text-sm font-semibold text-base-content shadow-sm transition hover:bg-base-200 hover:shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <GoogleGlyph className="size-[18px]" />
                Connect with Google
              </button>
              {onDismiss ? (
                <DismissButton onClick={onDismiss} disabled={dismissing} />
              ) : null}
            </div>
          </div>
        )}
      </IntegrationConnectionCard>
    </>
  );
}

function DismissButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm text-base-content/60"
      onClick={onClick}
      disabled={disabled}
    >
      Dismiss
    </button>
  );
}

function ConnectedState({
  displayName,
  propertyId,
  timeZone,
  currencyCode,
  connectedByEmail,
  onChange,
  onDisconnect,
  disconnecting,
}: {
  displayName: string;
  propertyId: string;
  timeZone: string;
  currencyCode: string;
  connectedByEmail: string | null;
  onChange: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  const numericPropertyId = propertyId.replace(/^properties\//, "");

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-base-300 bg-base-200/30 px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-base-content/45">
              Selected property
            </p>
            <p className="mt-0.5 truncate text-sm font-semibold">
              {displayName}
            </p>
          </div>
          <span className="rounded-md border border-base-300 bg-base-100 px-2 py-1 font-mono text-[11px] text-base-content/60">
            ID {numericPropertyId}
          </span>
        </div>

        <dl className="mt-3 grid gap-x-6 gap-y-2 border-t border-base-300/70 pt-3 text-xs sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-base-content/45">Time zone</dt>
            <dd className="mt-0.5 truncate font-medium text-base-content/75">
              {timeZone}
            </dd>
          </div>
          <div>
            <dt className="text-base-content/45">Currency</dt>
            <dd className="mt-0.5 font-medium text-base-content/75">
              {currencyCode}
            </dd>
          </div>
          {connectedByEmail ? (
            <div className="min-w-0">
              <dt className="text-base-content/45">Connected account</dt>
              <dd className="mt-0.5 truncate font-medium text-base-content/75">
                {connectedByEmail}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-outline btn-sm border-base-300 font-medium"
          onClick={onChange}
        >
          Change property
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm font-medium text-error hover:bg-error/10"
          onClick={onDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    </div>
  );
}
