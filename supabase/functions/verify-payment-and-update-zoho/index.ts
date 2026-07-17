// supabase/functions/verify-payment-and-update-zoho/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.22.0?target=deno";

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
    const { paymentId, sessionId } = await req.json();

    if (!paymentId) {
      throw new Error("Missing paymentId parameter.");
    }

    console.log("verify-payment-and-update-zoho triggered with paymentId:", paymentId);

    // Initialize Supabase Client with service role key to write to database
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Fetch transaction record from database
    console.log("Fetching transaction details from 'payments' table...");
    const { data: transaction, error: dbError } = await supabase
      .from("payments")
      .select("*")
      .eq("id", paymentId)
      .single();

    if (dbError || !transaction) {
      throw new Error(`Transaction not found: ${dbError?.message || ""}`);
    }

    console.log("Successfully fetched transaction from database. Current status:", transaction.status, "Invoice No:", transaction.invoice_no);

    // If already marked as paid, return success immediately
    if (transaction.status === "paid" && transaction.zoho_payment_recorded) {
      console.log("Transaction already paid and updated in Zoho. Exiting function.");
      return new Response(
        JSON.stringify({ message: "Payment was already completed and updated in Zoho Books." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Contact Stripe Gateway to verify session status
    let isSuccess = false;
    if (sessionId) {
      console.log(`Verifying payment status with Stripe for session: ${sessionId}`);
      const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
      if (!stripeSecretKey) {
        throw new Error("Stripe secret key is not configured in Supabase (STRIPE_SECRET_KEY).");
      }
      const stripe = new Stripe(stripeSecretKey, {
        httpClient: Stripe.createFetchHttpClient(),
      });
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status === "paid") {
        if (session.metadata?.paymentId === paymentId) {
          isSuccess = true;
          console.log(`Stripe payment successfully verified for paymentId: ${paymentId}`);
        } else {
          throw new Error("Stripe checkout session metadata does not match the payment ID.");
        }
      } else {
        throw new Error(`Stripe session payment status is: ${session.payment_status}`);
      }
    } else {
      throw new Error("Stripe session ID (sessionId) is missing in verification request.");
    }

    console.log("Stripe verification successful. Updating database status to paid...");


    // 3. Update local payment status in DB to "paid"
    const { error: updateDbError } = await supabase
      .from("payments")
      .update({ status: "paid" })
      .eq("id", paymentId);

    if (updateDbError) {
      throw new Error(`Failed to update status in local database: ${updateDbError.message}`);
    }
    console.log("Database status successfully updated to 'paid'.");

    // 4. Update Zoho Books (Search by invoice number if internal zoho_invoice_id is missing/empty)
    const hasZohoId = transaction.zoho_invoice_id && transaction.zoho_invoice_id.trim() !== "";
    const hasInvoiceNo = transaction.invoice_no && transaction.invoice_no.trim() !== "";

    if (hasZohoId || hasInvoiceNo) {
      console.log("Initiating Zoho Books status update...");
      
      // Step A: Refresh Zoho Access Token
      const zohoClientId = Deno.env.get("ZOHO_CLIENT_ID");
      const zohoClientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");
      const zohoRefreshToken = Deno.env.get("ZOHO_REFRESH_TOKEN");
      const zohoOrgId = Deno.env.get("ZOHO_ORG_ID");

      if (!zohoClientId || !zohoClientSecret || !zohoRefreshToken || !zohoOrgId) {
        throw new Error("Zoho configuration secrets are missing in Supabase.");
      }

      console.log("Refreshing Zoho Access Token...");
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
      console.log("Zoho Access Token successfully refreshed.");

      let zohoInvoiceId = transaction.zoho_invoice_id;
      let customerId = null;

      // Step B: Resolve IDs by searching by Invoice Number if internal ID is blank
      if (!zohoInvoiceId || zohoInvoiceId.trim() === "") {
        console.log("No Zoho Invoice ID found in DB. Searching Zoho Books by Invoice Number:", transaction.invoice_no);
        const searchEndpoint = `https://www.zohoapis.com/books/v3/invoices?organization_id=${zohoOrgId}&invoice_number=${transaction.invoice_no}`;
        const searchRes = await fetch(searchEndpoint, {
          method: "GET",
          headers: {
            "Authorization": `Zoho-oauthtoken ${accessToken}`
          }
        });

        if (!searchRes.ok) {
          const errText = await searchRes.text();
          throw new Error(`Failed to search invoice in Zoho by number: ${errText}`);
        }

        const searchData = await searchRes.json();
        const foundInvoice = searchData.invoices?.find(
          (inv: any) => inv.invoice_number === transaction.invoice_no
        );

        if (!foundInvoice) {
          throw new Error(`Invoice number '${transaction.invoice_no}' not found in Zoho Books.`);
        }

        zohoInvoiceId = foundInvoice.invoice_id;
        customerId = foundInvoice.customer_id;
        console.log("Successfully resolved internal IDs from Zoho search. Invoice ID:", zohoInvoiceId, "Customer ID:", customerId);

        // Save resolved ID to local DB
        await supabase
          .from("payments")
          .update({ zoho_invoice_id: zohoInvoiceId })
          .eq("id", paymentId);
      } else {
        // Otherwise, fetch customer_id using the stored zoho_invoice_id
        console.log("Fetching customer details for Zoho Invoice ID:", zohoInvoiceId);
        const invoiceEndpoint = `https://www.zohoapis.com/books/v3/invoices/${zohoInvoiceId}?organization_id=${zohoOrgId}`;
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
        customerId = invoiceData.invoice?.customer_id;
        console.log("Located customer ID for this invoice ID:", customerId);
      }

      if (!customerId) {
        throw new Error("Unable to locate Zoho Customer ID for this invoice.");
      }

      // Step C: Record customer payment in Zoho Books
      console.log("Recording customer payment to Zoho Books...");
      const paymentEndpoint = `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${zohoOrgId}`;
      const paymentPayload = {
        customer_id: customerId,
        payment_mode: "Credit Card",
        amount: transaction.amount,
        date: new Date().toISOString().split('T')[0],
        invoices: [
          {
            invoice_id: zohoInvoiceId,
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
      console.log("Customer payment successfully posted to Zoho Books.");

      // Step D: Update transaction logging in DB to confirm Zoho update is done
      const { error: updateDbZohoError } = await supabase
        .from("payments")
        .update({ zoho_payment_recorded: true })
        .eq("id", paymentId);

      if (updateDbZohoError) {
        throw new Error(`Failed to set zoho_payment_recorded in local database: ${updateDbZohoError.message}`);
      }
      console.log("Local database updated: zoho_payment_recorded = true.");
    } else {
      console.log("No Zoho Invoice ID or Invoice Number found for this payment transaction. Skipping Zoho Books update.");
    }

    return new Response(
      JSON.stringify({ 
        message: "Payment successfully verified. Zoho Books invoice updated to Paid." 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("verify-payment-and-update-zoho failed:", error.message || error);
    return new Response(
      JSON.stringify({ error: error.message || error }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

