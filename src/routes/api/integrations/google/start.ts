import { createFileRoute } from "@tanstack/react-router";
import { handleGoogleConnectStart } from "@/server/features/google/connect";

export const Route = createFileRoute("/api/integrations/google/start")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        handleGoogleConnectStart(request),
    },
  },
});
