import type { GoogleLinkProvider } from "@/shared/google-link";

/**
 * Send the browser through the Google consent flow for one provider. The
 * server route asks the integration gateway for Google's authorization URL
 * and, once Google calls back, returns the user to `returnTo` (a same-origin
 * path). Analytics walks two consents (Admin, then Data) before returning.
 */
export function startGoogleConnect(
  provider: GoogleLinkProvider,
  returnTo: string = `${window.location.pathname}${window.location.search}${window.location.hash}`,
): void {
  const url = new URL("/api/integrations/google/start", window.location.origin);
  url.searchParams.set("provider", provider);
  url.searchParams.set("returnTo", returnTo);
  window.location.assign(url.toString());
}
