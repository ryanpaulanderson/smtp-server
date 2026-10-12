/** Public authenticated MCP endpoint; Vercel supplies HTTPS termination. */
import { handleMcp } from "../../src/http/mcp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
export const GET = handleMcp;
export const POST = handleMcp;
export const OPTIONS = handleMcp;
