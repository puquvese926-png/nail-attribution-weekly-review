import { json } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  const origin = new URL(req.url).origin;
  const target = new URL("/api/posts/warehouse-sync-background?full=1&source=scheduled", origin);
  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  return json({
    ok: response.ok,
    status: response.ok ? "scheduled-background-started" : "scheduled-background-start-failed",
    statusCode: response.status
  }, response.ok ? 200 : 500);
};

export const config = {
  schedule: "0 20 * * *"
};
