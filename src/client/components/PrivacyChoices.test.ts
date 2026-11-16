import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { setRuntimeAuthMode } from "@/lib/auth-mode";
import { PrivacyBootstrap } from "./PrivacyChoices";

// The session hook is the network request: Better Auth's atom fetches
// /get-session on mount. Outside hosted/password the server 404s that route,
// so reading it is the bug this guards.
const { useSession } = vi.hoisted(() => ({
  useSession: vi.fn(() => {
    throw new Error("session read outside Better Auth modes");
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { updateUser: vi.fn() },
  useSession,
}));

afterEach(() => {
  setRuntimeAuthMode(undefined);
});

test.each(["cloudflare_access", "local_noauth", "everyapp"] as const)(
  "PrivacyBootstrap does not read the session in %s mode",
  (mode) => {
    setRuntimeAuthMode(mode);

    expect(renderToStaticMarkup(createElement(PrivacyBootstrap))).toBe("");
    expect(useSession).not.toHaveBeenCalled();
  },
);
