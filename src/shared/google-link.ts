/** Query param the Google connect callback appends to the return URL when the
 *  consent flow fails. Its value is the provider key ("gsc" | "ga4"); the
 *  `error` param beside it carries the code. */
export const GOOGLE_LINK_ERROR_PARAM = "google_link_error";

export type GoogleLinkProvider = "gsc" | "ga4";
