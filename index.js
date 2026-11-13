require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const VERSION = '2.0.0-PAYSTACK-SUPABASE';

// Enable CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-paystack-signature']
}));

// Body Parsers (with rawBody capture for exact Paystack HMAC verification)
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ extended: true }));

// --- Supabase Client Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (supabaseUrl && supabaseServiceKey) {
    supabase = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { persistSession: false }
    });
    console.log('✅ Supabase initialized successfully.');
} else {
    console.warn('⚠️ Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured.');
}

// --- Paystack Configuration ---
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
if (!paystackSecretKey) {
    console.warn('⚠️ Warning: PAYSTACK_SECRET_KEY not set.');
}

// Helper: Format Kenyan Phone Numbers
function formatKenyanPhone(phone) {
    if (!phone) return '';
    let cleaned = phone.toString().trim().replace(/[\s\-\(\)]/g, '');
    if (cleaned.startsWith('+254')) return cleaned;
    if (cleaned.startsWith('254')) return `+${cleaned}`;
    if (cleaned.startsWith('0')) return `+254${cleaned.substring(1)}`;
    if (cleaned.startsWith('7') || cleaned.startsWith('1')) return `+254${cleaned}`;
    return cleaned;
}

// ============================================================================
// API ROUTES
// ============================================================================

// 1. Initialize Payment / STK Push via Paystack
// Handles both /api/mpesa/stkpush (frontend compatibility) and /api/payment/initialize
const handlePaymentInit = async (req, res) => {
    try {
        const { phoneNumber, amount, category, email } = req.body;

        if (!phoneNumber || !amount) {
            return res.status(400).json({ success: false, message: 'Phone number and amount are required.' });
        }

        const formattedPhone = formatKenyanPhone(phoneNumber);
        const numericPhone = formattedPhone.replace('+', '');
        const studentEmail = email || `${numericPhone}@student.course-corner.com`;
        const amountInCents = Math.round(Number(amount) * 100); // Paystack uses KES subunit (cents)

        // Unique reference
        const reference = `CC_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`.toUpperCase();
        const sessionId = req.body.sessionId || `sess_${reference}`;

        // SIMULATION / TEST MODE: Allows testing even before Paystack live keys are entered
        const isDemo = !paystackSecretKey || paystackSecretKey === 'demo' || paystackSecretKey.includes('your_key_here');
        if (isDemo) {
            console.log(`🧪 TEST MODE: Simulating payment approval for ${formattedPhone} (${amount} KES)...`);
            if (supabase) {
                await supabase.from('payments').insert({
                    reference,
                    session_id: sessionId,
                    phone_number: formattedPhone,
                    email: studentEmail,
                    amount: Number(amount),
                    currency: 'KES',
                    category: category || 'Course Calculator',
                    status: 'completed',
                    channel: 'test_simulation',
                    mpesa_receipt: `TEST_${Math.random().toString(36).substring(2, 9).toUpperCase()}`
                });
            }

            return res.json({
                success: true,
                data: {
                    reference,
                    checkoutRequestId: reference,
                    sessionId,
                    amount: Number(amount),
                    message: 'Test payment confirmed! Unlocking results...'
                }
            });
        }

        let paystackResponseData = null;
        let authorizationUrl = null;

        // Attempt 1: Direct M-Pesa Mobile Money Charge (Prompts user's phone with STK push)
        try {
            console.log(`Initiating Paystack Mobile Money Charge for ${formattedPhone} (${amount} KES)...`);
            const chargeResponse = await axios.post(
                'https://api.paystack.co/charge',
                {
                    email: studentEmail,
                    amount: amountInCents,
                    currency: 'KES',
                    reference,
                    mobile_money: {
                        phone: numericPhone,
                        provider: 'mpesa'
                    },
                    metadata: {
                        sessionId,
                        category: category || 'Course Calculator',
                        phoneNumber: formattedPhone
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${paystackSecretKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            paystackResponseData = chargeResponse.data?.data;
            console.log('✅ Paystack Charge initiated:', paystackResponseData?.status);
        } catch (chargeErr) {
            console.warn('Direct charge failed, falling back to transaction initialize:', chargeErr.response?.data?.message || chargeErr.message);

            // Fallback: Initialize standard transaction (provides Paystack checkout link/popup)
            const initResponse = await axios.post(
                'https://api.paystack.co/transaction/initialize',
                {
                    email: studentEmail,
                    amount: amountInCents,
                    currency: 'KES',
                    reference,
                    channels: ['mobile_money', 'card'],
                    callback_url: `${(process.env.BACKEND_URL || '').replace(/\/$/, '')}/api/payment/callback`,
                    metadata: {
                        sessionId,
                        category: category || 'Course Calculator',
                        phoneNumber: formattedPhone
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${paystackSecretKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            paystackResponseData = initResponse.data?.data;
            authorizationUrl = paystackResponseData?.authorization_url;
        }

        // Save pending payment record in Supabase
        if (supabase) {
            const { error: dbError } = await supabase.from('payments').insert({
                reference,
                session_id: sessionId,
                phone_number: formattedPhone,
                email: studentEmail,
                amount: Number(amount),
                currency: 'KES',
                category: category || 'Course Calculator',
                status: 'pending',
                channel: 'mobile_money',
                metadata: {
                    paystackData: paystackResponseData
                }
            });

            if (dbError) {
                console.error('Supabase Insert Error:', dbError.message);
            }
        }

        return res.json({
            success: true,
            data: {
                reference,
                checkoutRequestId: reference, // for frontend compatibility
                sessionId,
                amount: Number(amount),
                authorizationUrl: authorizationUrl || paystackResponseData?.authorization_url || null,
                message: 'M-Pesa payment prompt sent to your phone. Please check your screen and enter your PIN.'
            }
        });

    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message || 'Payment initiation failed';
        console.error('Payment Init Error:', errorMsg);
        return res.status(500).json({ success: false, message: errorMsg });
    }
};

app.post('/api/mpesa/stkpush', handlePaymentInit);
app.post('/api/payment/initialize', handlePaymentInit);

// 2. Paystack Webhook Handler
// Handles both /api/paystack/webhook and /api/mpesa/callback
const handlePaystackWebhook = async (req, res) => {
    try {
        // Validate Paystack HMAC SHA-512 signature
        const signature = req.headers['x-paystack-signature'];
        const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET || paystackSecretKey;

        if (signature && (webhookSecret || paystackSecretKey)) {
            const checkSecret = (sec) => {
                if (!sec) return null;
                const hmac = crypto.createHmac('sha512', sec);
                if (req.rawBody) {
                    hmac.update(req.rawBody);
                } else {
                    hmac.update(JSON.stringify(req.body));
                }
                return hmac.digest('hex');
            };

            const hashPrimary = checkSecret(webhookSecret);
            const hashFallback = checkSecret(paystackSecretKey);

            if (hashPrimary !== signature && hashFallback !== signature) {
                console.warn('⚠️ Webhook signature mismatch. Request rejected.');
                return res.status(401).send('Invalid signature');
            }
        }

        const event = req.body;
        console.log(`📩 Paystack Webhook Event: ${event.event} for Ref: ${event.data?.reference}`);

        // Log webhook in Supabase
        if (supabase) {
            await supabase.from('webhook_logs').insert({
                event: event.event || 'unknown',
                reference: event.data?.reference || null,
                payload: event
            });
        }

        // Process successful charge
        if (event.event === 'charge.success') {
            const data = event.data;
            const reference = data.reference;
            const mpesaReceipt = data.metadata?.mpesa_receipt || data.id?.toString() || reference;

            if (supabase) {
                const { error: updateError } = await supabase
                    .from('payments')
                    .update({
                        status: 'completed',
                        channel: data.channel || 'mobile_money',
                        mpesa_receipt: mpesaReceipt,
                        paystack_id: data.id,
                        updated_at: new Date().toISOString()
                    })
                    .eq('reference', reference);

                if (updateError) {
                    console.error('Failed to update payment status in Supabase:', updateError.message);
                } else {
                    console.log(`✅ Payment Ref ${reference} marked COMPLETED in Supabase!`);
                }
            }
        }

        // Acknowledge receipt to Paystack
        return res.status(200).send('OK');

    } catch (err) {
        console.error('Webhook Error:', err);
        return res.status(500).send('Server error');
    }
};

app.post('/api/paystack/webhook', handlePaystackWebhook);
app.post('/api/mpesa/callback', handlePaystackWebhook);

// 3. Payment Status Polling / Fallback Verification
// Handles /api/mpesa/status and /api/payment/status
const handleStatusCheck = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    try {
        const reference = req.query.reference || req.query.checkoutRequestId;
        const sessionId = req.query.sessionId;

        if (!reference && !sessionId) {
            return res.status(400).json({ success: false, message: 'Reference or sessionId required.' });
        }

        if (!supabase) {
            return res.status(500).json({ success: false, message: 'Supabase database not initialized.' });
        }

        // Query Supabase
        let query = supabase.from('payments').select('*').limit(1);
        if (reference) {
            query = query.eq('reference', reference);
        } else if (sessionId) {
            query = query.eq('session_id', sessionId);
        }

        const { data, error } = await query;

        if (error || !data || data.length === 0) {
            return res.status(404).json({ success: false, message: 'Payment record not found.' });
        }

        const payment = data[0];

        // If still pending, directly verify with Paystack in case webhook was delayed
        if (payment.status === 'pending' && paystackSecretKey && payment.reference) {
            try {
                const verifyRes = await axios.get(
                    `https://api.paystack.co/transaction/verify/${payment.reference}`,
                    { headers: { Authorization: `Bearer ${paystackSecretKey}` } }
                );

                if (verifyRes.data?.data?.status === 'success') {
                    // Update database
                    await supabase
                        .from('payments')
                        .update({
                            status: 'completed',
                            channel: verifyRes.data.data.channel || 'mobile_money',
                            mpesa_receipt: verifyRes.data.data.reference,
                            updated_at: new Date().toISOString()
                        })
                        .eq('reference', payment.reference);

                    payment.status = 'completed';
                    payment.mpesa_receipt = verifyRes.data.data.reference;
                }
            } catch (vErr) {
                // Ignore verify failure and return current status
            }
        }

        return res.json({
            success: true,
            data: {
                status: payment.status,
                reference: payment.reference,
                amount: payment.amount,
                category: payment.category,
                mpesaCode: payment.mpesa_receipt || payment.reference
            }
        });

    } catch (err) {
        console.error('Status Check Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

app.get('/api/mpesa/status', handleStatusCheck);
app.get('/api/payment/status', handleStatusCheck);

// 4. Access Verification
app.post('/api/payment/has-access', async (req, res) => {
    try {
        const { sessionId, reference } = req.body;
        if (!sessionId && !reference) return res.json({ hasAccess: false });

        if (!supabase) return res.status(500).json({ success: false, message: 'Database not initialized.' });

        let query = supabase.from('payments').select('id, status').eq('status', 'completed').limit(1);
        if (reference) {
            query = query.eq('reference', reference);
        } else {
            query = query.eq('session_id', sessionId);
        }

        const { data } = await query;
        const hasAccess = data && data.length > 0;

        return res.json({ success: true, hasAccess });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// 5. Verify M-Pesa Code Manually
app.post('/api/mpesa/verify-mpesa-code', async (req, res) => {
    try {
        const { mpesaCode } = req.body;
        if (!mpesaCode) return res.status(400).json({ success: false, message: 'Code required.' });
        if (!supabase) return res.status(500).json({ success: false, message: 'Database not initialized.' });

        const trimmed = mpesaCode.trim().toUpperCase();
        const { data, error } = await supabase
            .from('payments')
            .select('*')
            .or(`mpesa_receipt.eq.${trimmed},reference.eq.${trimmed}`)
            .eq('status', 'completed')
            .limit(1);

        if (error || !data || data.length === 0) {
            return res.status(404).json({ success: false, message: 'Transaction code not found or not yet confirmed.' });
        }

        return res.json({ success: true, data: data[0] });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// 6. Health Check & Ping
app.get('/', (req, res) => {
    res.send(`Course Corner Backend API is running (${VERSION}).`);
});

app.get('/api/ping', (req, res) => {
    res.json({ ok: true, version: VERSION, timestamp: Date.now() });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Course Corner API (${VERSION}) listening on port ${PORT}`);
});
