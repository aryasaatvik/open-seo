import { createFileRoute } from "@tanstack/react-router";
import { handleGoogleConnectCallback } from "@/server/features/google/connect";

export const Route = createFileRoute("/api/integrations/google/callback")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        handleGoogleConnectCallback(request),
    },
  },
});
