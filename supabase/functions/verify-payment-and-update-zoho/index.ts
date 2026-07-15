// supabase/functions/verify-payment-and-update-zoho/index.ts
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
    const { paymentId } = await req.json();

    if (!paymentId) {
      throw new Error("Missing paymentId parameter.");
    }

    // Initialize Supabase Client with service role key to write to database
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Fetch transaction record from database
    const { data: transaction, error: dbError } = await supabase
      .from("payments")
      .select("*")
      .eq("id", paymentId)
      .single();

    if (dbError || !transaction) {
      throw new Error(`Transaction not found: ${dbError?.message || ""}`);
    }

    // If already marked as paid, return success immediately
    if (transaction.status === "paid" && transaction.zoho_payment_recorded) {
      return new Response(
        JSON.stringify({ message: "Payment was already completed and updated in Zoho Books." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Contact Bancstac Gateway to verify order status
    const merchantId = Deno.env.get("BANCSTAC_MERCHANT_ID");
    const apiPassword = Deno.env.get("BANCSTAC_API_PASSWORD");
    const gatewayUrl = Deno.env.get("BANCSTAC_GATEWAY_URL");

    if (!merchantId || !apiPassword || !gatewayUrl) {
      throw new Error("Payment gateway secrets are not configured in Supabase.");
    }

    const bancstacEndpoint = `${gatewayUrl}/merchant/${merchantId}/order/${transaction.invoice_no}`;
    const credentials = btoa(`merchant.${merchantId}:${apiPassword}`);

    const bancstacRes = await fetch(bancstacEndpoint, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${credentials}`
      }
    });

    if (!bancstacRes.ok) {
      const errText = await bancstacRes.text();
      throw new Error(`Failed to query gateway status: ${errText}`);
    }

    const orderData = await bancstacRes.json();
    
    // Check if the transaction state indicates success (e.g. status is CAPTURED or APPROVED)
    const isSuccess = orderData.status === "CAPTURED" || orderData.status === "APPROVED" || orderData.status === "SUCCESS";
    
    if (!isSuccess) {
      throw new Error(`Gateway returned payment status: ${orderData.status}`);
    }

    // 3. Update local payment status in DB to "paid"
    const { error: updateDbError } = await supabase
      .from("payments")
      .update({ status: "paid" })
      .eq("id", paymentId);

    if (updateDbError) {
      throw new Error(`Failed to update status in local database: ${updateDbError.message}`);
    }

    // 4. Update Zoho Books if zoho_invoice_id is attached to transaction
    if (transaction.zoho_invoice_id) {
      // Step A: Refresh Zoho Access Token
      const zohoClientId = Deno.env.get("ZOHO_CLIENT_ID");
      const zohoClientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");
      const zohoRefreshToken = Deno.env.get("ZOHO_REFRESH_TOKEN");
      const zohoOrgId = Deno.env.get("ZOHO_ORG_ID");

      if (!zohoClientId || !zohoClientSecret || !zohoRefreshToken || !zohoOrgId) {
        throw new Error("Zoho configuration secrets are missing in Supabase.");
      }

      const tokenRes = await fetch("https://accounts.zoho.com/oauth/v2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: zohoRefreshToken,
          client_id: zohoClientId,
          client_secret: zohoClientSecret,
          grant_type: "refresh_token",
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Failed to refresh Zoho Access Token: ${errText}`);
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      // Step B: Get Customer ID of the Invoice from Zoho Books
      const invoiceEndpoint = `https://www.zohoapis.com/books/v3/invoices/${transaction.zoho_invoice_id}?organization_id=${zohoOrgId}`;
      const invoiceRes = await fetch(invoiceEndpoint, {
        method: "GET",
        headers: {
          "Authorization": `Zoho-oauthtoken ${accessToken}`
        }
      });

      if (!invoiceRes.ok) {
        const errText = await invoiceRes.text();
        throw new Error(`Failed to retrieve invoice details from Zoho: ${errText}`);
      }

      const invoiceData = await invoiceRes.json();
      const customerId = invoiceData.invoice?.customer_id;

      if (!customerId) {
        throw new Error("Unable to locate Zoho Customer ID for this invoice.");
      }

      // Step C: Record customer payment in Zoho Books
      const paymentEndpoint = `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${zohoOrgId}`;
      const paymentPayload = {
        customer_id: customerId,
        payment_mode: "Credit Card",
        amount: transaction.amount,
        date: new Date().toISOString().split('T')[0],
        invoices: [
          {
            invoice_id: transaction.zoho_invoice_id,
            amount_applied: transaction.amount
          }
        ]
      };

      const zohoPaymentRes = await fetch(paymentEndpoint, {
        method: "POST",
        headers: {
          "Authorization": `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(paymentPayload)
      });

      if (!zohoPaymentRes.ok) {
        const errText = await zohoPaymentRes.text();
        throw new Error(`Failed to record payment in Zoho Books: ${errText}`);
      }

      // Step D: Update transaction logging in DB to confirm Zoho update is done
      await supabase
        .from("payments")
        .update({ zoho_payment_recorded: true })
        .eq("id", paymentId);
    }

    return new Response(
      JSON.stringify({ 
        message: "Payment successfully verified. Zoho Books invoice updated to Paid." 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
