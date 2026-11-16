import {
  Link,
  Outlet,
  createFileRoute,
  useMatch,
} from "@tanstack/react-router";
import { AuthPageCard, AuthPageShell } from "@/client/features/auth/AuthPage";
import { useHostedAuthRouteGuard } from "@/client/features/auth/useHostedAuthRouteGuard";
import { PageLoading } from "@/client/components/Spinner";
import { Button } from "@/client/components/ui/button";
import { usesBetterAuthClient } from "@/lib/auth-mode";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedShellLayout,
});

function AuthenticatedShellLayout() {
  const isOAuthConsent = Boolean(
    useMatch({ from: "/_authenticated/oauth-consent", shouldThrow: false }),
  );

  // Every page under this layout needs Better Auth accounts (hosted or
  // password). Without them the guard's session read can only 404, so show the
  // unavailable card without mounting it.
  if (!usesBetterAuthClient()) {
    return <NotAvailable />;
  }

  return <BetterAuthAuthenticatedShellLayout isOAuthConsent={isOAuthConsent} />;
}

function BetterAuthAuthenticatedShellLayout({
  isOAuthConsent,
}: {
  isOAuthConsent: boolean;
}) {
  const authGate = useHostedAuthRouteGuard();
  // MCP consent works in both account modes; every other page here is
  // hosted-only.
  const isAvailable = isOAuthConsent || authGate.isHostedMode;
  if (!isAvailable) {
    return <NotAvailable />;
  }

  if (!authGate.canRenderAuthenticatedContent) {
    return <PageLoading />;
  }

  return (
    <AuthPageShell>
      <Outlet />
    </AuthPageShell>
  );
}

function NotAvailable() {
  return (
    <AuthPageShell>
      <AuthPageCard
        title="Not available"
        helperText="This page isn't available right now."
      >
        <Button
          nativeButton={false}
          render={<Link to="/" />}
          variant="secondary"
          className="w-full"
        >
          Back to OpenSEO
        </Button>
      </AuthPageCard>
    </AuthPageShell>
  );
}
