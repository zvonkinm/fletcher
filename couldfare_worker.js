var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://zvonkinm.github.io"
];
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
__name(corsHeaders, "corsHeaders");
var index_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/token") {
      return new Response("Not found", {
        status: 404,
        headers: corsHeaders(origin)
      });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_request", error_description: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
      });
    }
    let tokenParams;
    if (body.grant_type === "refresh_token") {
      const { refresh_token } = body;
      if (!refresh_token) {
        return new Response(JSON.stringify({ error: "invalid_request", error_description: "Missing required field: refresh_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
        });
      }
      tokenParams = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      });
    } else {
      const { code, code_verifier, redirect_uri } = body;
      if (!code || !code_verifier || !redirect_uri) {
        return new Response(JSON.stringify({ error: "invalid_request", error_description: "Missing required fields: code, code_verifier, redirect_uri" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
        });
      }
      tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier,
        redirect_uri,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      });
    }
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams
    });
    const tokenData = await tokenResponse.json();
    return new Response(JSON.stringify(tokenData), {
      status: tokenResponse.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin)
      }
    });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
