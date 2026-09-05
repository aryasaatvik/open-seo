import {
  DATAFORSEO_INTEGRATION,
  GOOGLE_ANALYTICS_ADMIN_INTEGRATION,
  GOOGLE_ANALYTICS_DATA_INTEGRATION,
  GOOGLE_SEARCH_CONSOLE_INTEGRATION,
} from "../../../src/shared/integration-addresses";

// The Google APIs the app calls, registered from their Discovery documents
// through Executor's `google-discovery` spec format. Declared here rather than
// taken from the plugin's preset catalog, which ships Search Console but not
// Analytics. Scopes are what OpenSEO's own OAuth flows requested; the
// identity scopes let Executor label the connection with the account email.
export const GOOGLE_INTEGRATIONS = [
  {
    slug: GOOGLE_SEARCH_CONSOLE_INTEGRATION,
    name: "Google Search Console",
    description:
      "Search Console: verified properties, search analytics, URL inspection.",
    discoveryUrl:
      "https://www.googleapis.com/discovery/v1/apis/searchconsole/v1/rest",
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  },
  {
    slug: GOOGLE_ANALYTICS_DATA_INTEGRATION,
    name: "Google Analytics Data",
    description: "GA4 Data API: runReport over a property.",
    discoveryUrl:
      "https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta",
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  },
  {
    slug: GOOGLE_ANALYTICS_ADMIN_INTEGRATION,
    name: "Google Analytics Admin",
    description:
      "GA4 Admin API: account summaries, properties, data streams, key events, custom definitions.",
    discoveryUrl:
      "https://analyticsadmin.googleapis.com/$discovery/rest?version=v1alpha",
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  },
] as const;

export const GOOGLE_INTEGRATION_SLUGS: readonly string[] =
  GOOGLE_INTEGRATIONS.map((integration) => integration.slug);

export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"] as const;
export const GOOGLE_AUTH_TEMPLATE = "googleOAuth2";
export const GOOGLE_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// The auth template slug the DataForSEO connection renders through. The
// connection value is the base64 `login:password` OpenSEO already calls
// DATAFORSEO_API_KEY; the template prefixes it with "Basic ".
export const DATAFORSEO_AUTH_TEMPLATE = "basic";
export { DATAFORSEO_INTEGRATION };
