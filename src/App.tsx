import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import './App.css';

function App() {
  const [invoiceNo, setInvoiceNo] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  
  // Zoho Books Integration state
  const [zohoInvoiceId, setZohoInvoiceId] = useState('');
  const [isLocked, setIsLocked] = useState(false);

  // Payment Verification / Callback Page state
  const [paymentStatus, setPaymentStatus] = useState<'form' | 'verifying' | 'success' | 'error'>('form');
  const [callbackMessage, setCallbackMessage] = useState('');

  useEffect(() => {
    // 1. Detect if we are on the payment callback redirect page
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get('paymentId');
    const sessionId = params.get('session_id');
    const path = window.location.pathname;

    // Check both query param and pathname to handle redirects robustly
    if (path === '/payment-callback' || params.has('paymentId')) {
      if (paymentId) {
        setPaymentStatus('verifying');
        verifyPayment(paymentId, sessionId || undefined);
      } else {
        setPaymentStatus('error');
        setErrorMessage('Invalid redirect. No payment session identifier found.');
      }
      return;
    }

    // 2. Otherwise, check for Zoho Invoice parameters to pre-populate the form
    const dataParam = params.get('data');
    let parsedData: any = null;

    if (dataParam) {
      try {
        // Try parsing directly (in case it is raw JSON)
        parsedData = JSON.parse(dataParam);
      } catch (e) {
        try {
          // Try decoding URI component (in case it is URL-encoded JSON)
          parsedData = JSON.parse(decodeURIComponent(dataParam));
        } catch (e2) {
          try {
            // Try base64 decoding (in case it is Base64 encoded JSON)
            parsedData = JSON.parse(atob(dataParam));
          } catch (e3) {
            console.error('Failed to parse JSON data parameter:', e3);
          }
        }
      }
    }

    const getVal = (key: string, jsonVal: any) => {
      if (jsonVal !== undefined && jsonVal !== null) {
        return String(jsonVal);
      }
      return params.get(key);
    };

    const zId = getVal('invoice_id', parsedData?.invoice_id);
    const zNo = getVal('invoice_no', parsedData?.invoice_no);
    const zAmt = getVal('amount', parsedData?.amount);
    const zName = getVal('customer_name', parsedData?.customer_name);

    if (zId) setZohoInvoiceId(zId);
    if (zNo) setInvoiceNo(zNo);
    if (zName) setName(zName);
    if (zAmt) {
      // Strip any currency symbols, spaces, or commas (e.g. "LKR 1,500.00" -> "1500.00")
      const cleanedAmount = zAmt.replace(/[^\d.]/g, '');
      setAmount(cleanedAmount);
    }

    // Lock the form inputs if it has been launched via an official invoice link
    if (zId || zNo) {
      setIsLocked(true);
      // Auto-agree to terms since they are completing a formal invoice payment
      setAgreed(true);
    }
  }, []);

  const verifyPayment = async (paymentId: string, sessionId?: string) => {
    try {
      // Invoke the Edge Function to verify payment status and update Zoho Books
      const { data, error } = await supabase.functions.invoke('verify-payment-and-update-zoho', {
        body: { paymentId, sessionId }
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setPaymentStatus('success');
      setCallbackMessage(data?.message || 'Your payment was processed successfully, and Zoho Books has been updated.');
    } catch (err: any) {
      setPaymentStatus('error');
      setErrorMessage(err.message || 'An error occurred during payment verification. Please contact support.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');

    if (!invoiceNo || !name || !amount) {
      setErrorMessage('Please fill in all payment details.');
      return;
    }

    if (parseFloat(amount) <= 0) {
      setErrorMessage('Please enter a valid payment amount.');
      return;
    }

    if (!agreed) {
      setErrorMessage('You must agree to the Terms and Conditions.');
      return;
    }

    setLoading(true);

    try {
      // 1. Log the transaction as 'pending' in Supabase Database, including zoho_invoice_id if it exists
      const { data: dbData, error: dbError } = await supabase
        .from('payments')
        .insert([
          { 
            invoice_no: invoiceNo, 
            customer_name: name, 
            amount: parseFloat(amount), 
            status: 'pending',
            zoho_invoice_id: zohoInvoiceId || null
          }
        ])
        .select()
        .single();

      if (dbError) throw dbError;

      // 2. Request a payment session redirect URL from Supabase Edge Function
      const { data, error: functionError } = await supabase.functions.invoke('create-payment-session', {
        body: {
          paymentId: dbData.id,
          invoiceNo,
          name,
          amount: parseFloat(amount)
        }
      });

      if (functionError) throw functionError;

      // 3. Redirect user to Bancstac Payment Gateway
      if (data?.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        throw new Error('Payment gateway did not return a valid session URL.');
      }

    } catch (err: any) {
      setErrorMessage(err.message || 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Render verifying state
  if (paymentStatus === 'verifying') {
    return (
      <div className="payment-container">
        <div className="glass-card text-center">
          <div className="brand-header animate-pulse">
            <h2>Verifying Payment</h2>
            <p>Confirming transaction details with Stripe and updating Zoho Books. Please do not close or reload this page.</p>
          </div>
          <div className="spinner-large"></div>
        </div>
      </div>
    );
  }

  // Render success state
  if (paymentStatus === 'success') {
    return (
      <div className="payment-container">
        <div className="glass-card text-center success-card">
          <div className="success-icon">✓</div>
          <div className="brand-header">
            <h2 className="text-success">Payment Successful</h2>
            <p>{callbackMessage}</p>
          </div>
          <button onClick={() => window.location.href = '/'} className="submit-btn">
            Return to Checkout
          </button>
        </div>
      </div>
    );
  }

  // Render error state on verification page
  if (paymentStatus === 'error' && window.location.search.includes('paymentId')) {
    return (
      <div className="payment-container">
        <div className="glass-card text-center error-card">
          <div className="error-icon">✗</div>
          <div className="brand-header">
            <h2 className="text-error">Verification Failed</h2>
            <p>{errorMessage}</p>
          </div>
          <button onClick={() => window.location.href = '/'} className="submit-btn btn-retry">
            Return to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="payment-container">
      <div className="glass-card">
        <div className="brand-header">
          <h2>Secure Checkout</h2>
          <p>
            {isLocked 
              ? `Review details and pay for Zoho Books Invoice ${invoiceNo}`
              : 'Provide your invoice details to complete the payment'}
          </p>
        </div>

        {errorMessage && <div className="error-banner">{errorMessage}</div>}

        <form onSubmit={handleSubmit} className="payment-form">
          <div className="form-group">
            <label htmlFor="invoiceNo">Invoice Number</label>
            <input
              type="text"
              id="invoiceNo"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              readOnly={isLocked}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="name">Billing Name</label>
            <input
              type="text"
              id="name"
              placeholder="e.g. John Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              readOnly={isLocked}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="amount">Payment Amount (LKR)</label>
            <input
              type="number"
              id="amount"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              readOnly={isLocked}
              required
            />
          </div>

          <div className="form-checkbox">
            <label className="checkbox-container">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                // disabled={isLocked} // Auto-checked and disabled if loading from Invoice URL
              />
              <span className="checkmark"></span>
              <span className="checkbox-label">
                I agree to the <a href="#terms" className="accent-link">Terms and Conditions</a>
              </span>
            </label>
          </div>

          <button type="submit" className="submit-btn" disabled={loading}>
            {loading ? <span className="spinner"></span> : 'Proceed to Payment'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;

