/** Public OAuth resource metadata for supported MCP clients. */
import { resourceMetadata } from "../../../src/http/mcp";

export const dynamic = "force-dynamic";
export const GET = resourceMetadata;
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}
