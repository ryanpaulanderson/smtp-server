/** Minimal service identification; never performs a send or exposes configuration. */
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    {
      service: "encrypted-email-mcp",
      endpoint: "/mcp",
      documentation: "https://github.com/ryanpaulanderson/smtp-server",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
