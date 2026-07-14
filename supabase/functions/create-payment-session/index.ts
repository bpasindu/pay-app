// supabase/functions/create-payment-session/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { paymentId, invoiceNo, name, amount } = await req.json();

    // 1. Configure gateway credentials from environment variables
    const merchantId = Deno.env.get("BANCSTAC_MERCHANT_ID");
    const apiPassword = Deno.env.get("BANCSTAC_API_PASSWORD");
    const gatewayUrl = Deno.env.get("BANCSTAC_GATEWAY_URL"); // Provided by bank e.g. https://test-gateway.bancstac.com/api/rest/version/72

    if (!merchantId || !apiPassword || !gatewayUrl) {
      throw new Error("Missing payment gateway environment variables.");
    }

    // 2. Build session payload for Bancstac / MPGS API
    const sessionPayload = {
      apiOperation: "CREATE_CHECKOUT_SESSION",
      interaction: {
        operation: "PURCHASE",
        returnUrl: `${req.headers.get("origin")}/payment-callback?paymentId=${paymentId}`,
        merchant: {
          name: "Your Company Ltd"
        }
      },
      order: {
        id: invoiceNo,
        amount: amount.toFixed(2),
        currency: "LKR", // Set target currency (e.g. LKR)
        description: `Invoice ${invoiceNo}`
      }
    };

    // 3. Send request to Bancstac / MPGS Gateway
    const endpoint = `${gatewayUrl}/merchant/${merchantId}/session`;
    const credentials = btoa(`merchant.${merchantId}:${apiPassword}`); // Basic Authentication Header

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${credentials}`
      },
      body: JSON.stringify(sessionPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gateway Error: ${errorText}`);
    }

    const gatewaySessionData = await response.json();

    // Bancstac/MPGS returns session.id. Hosted pages are initialized using:
    // https://<bank-gateway-domain>/checkout/pay/<sessionId>
    // Adjust target URL base matching your acquiring bank's hosted payment portal
    const redirectUrl = `${Deno.env.get("BANCSTAC_CHECKOUT_BASE_URL")}/checkout/pay/${gatewaySessionData.session.id}`;

    return new Response(
      JSON.stringify({ redirectUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
