import React, { useState } from 'react';
import { supabase } from './supabaseClient';
import './App.css';

function App() {
  const [invoiceNo, setInvoiceNo] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

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
      // 1. Log the transaction as 'pending' in Supabase Database
      const { data: dbData, error: dbError } = await supabase
        .from('payments')
        .insert([
          { invoice_no: invoiceNo, customer_name: name, amount: parseFloat(amount), status: 'pending' }
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

  return (
    <div className="payment-container">
      <div className="glass-card">
        <div className="brand-header">
          <h2>Secure Checkout</h2>
          <p>Provide your invoice details to complete the payment via Bancstac</p>
        </div>

        {errorMessage && <div className="error-banner">{errorMessage}</div>}

        <form onSubmit={handleSubmit} className="payment-form">
          <div className="form-group">
            <label htmlFor="invoiceNo">Invoice Number</label>
            <input
              type="text"
              id="invoiceNo"
              placeholder="e.g. INV-2026-001"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
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
              required
            />
          </div>

          <div className="form-checkbox">
            <label className="checkbox-container">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
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
