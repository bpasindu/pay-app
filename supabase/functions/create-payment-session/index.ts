// supabase/functions/create-payment-session/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
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
    const { paymentId, invoiceNo, name, amount } = await req.json();

    if (!paymentId || !invoiceNo || !amount) {
      throw new Error("Missing required parameters: paymentId, invoiceNo, or amount.");
    }

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      throw new Error("Stripe secret key is not configured in Supabase (STRIPE_SECRET_KEY).");
    }

    // Initialize Stripe with Deno's fetch-based HTTP client
    const stripe = new Stripe(stripeSecretKey, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    console.log(`Creating Stripe checkout session for Invoice: ${invoiceNo}, Amount: ${amount}`);

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'lkr',
            product_data: {
              name: `Invoice ${invoiceNo}`,
              description: `Billing Name: ${name}`,
            },
            unit_amount: Math.round(amount * 100), // Stripe expects amount in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${req.headers.get("origin")}/payment-callback?paymentId=${paymentId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.get("origin")}/`,
      metadata: {
        paymentId,
        invoiceNo,
      },
    });

    if (!session.url) {
      throw new Error("Stripe did not return a checkout redirect URL.");
    }

    console.log(`Stripe session created successfully. Redirecting to: ${session.url}`);

    return new Response(
      JSON.stringify({ redirectUrl: session.url }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("create-payment-session failed:", error.message || error);
    return new Response(
      JSON.stringify({ error: error.message || error }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

