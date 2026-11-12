require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Express
const app = express();
const VERSION = "1.1.0-HARDENED-POLLING"; // Unique ID to track deployment

// Aggressive CORS for Webhooks
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

// Use exact raw JSON parsing for webhooks to avoid stripping
app.use(express.json({ strict: false }));
app.use(express.urlencoded({ extended: true }));

// Ensure Firebase Service Account Key is provided
// You will get this JSON from Firebase Console -> Project Settings -> Service Accounts
// Save it in the root of the backend folder as firebase-service-account.json
// --- Firebase Admin SDK Setup ---
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Option A: Env Variable (Best for Vercel)
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin Initialized via ENV.');
    } else {
        // Option B: Local File
        const serviceAccount = require('./firebase-service-account.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin Initialized via File.');
    }
} catch (error) {
    console.warn('⚠️ Firebase Warning: No credentials found. Firestore features will be disabled.');
    console.error('Firebase Init Error:', error.message);
}

const db = admin.apps.length ? admin.firestore() : null;


// --- LipaNa.dev Configuration ---
const lipanaSecretKey = process.env.LIPANA_SECRET_KEY;

if (!lipanaSecretKey) {
    console.warn('⚠️ Warning: LIPANA_SECRET_KEY is not set in environment variables.');
}

// --- API Routes ---

// 1. STK Push Route
app.post('/api/mpesa/stkpush', async (req, res) => {
    try {
        const { phoneNumber, amount, category, referralCode } = req.body;

        if (!phoneNumber || !amount) {
            return res.status(400).json({ success: false, message: 'Phone number and amount are required' });
        }

        if (!lipanaSecretKey) {
            console.error('FATAL: LIPANA_SECRET_KEY is not set in environment variables.');
            return res.status(500).json({ 
                success: false, 
                message: 'Internal Configuration Error: API Key missing. Please set LIPANA_SECRET_KEY on Vercel.' 
            });
        }

        // Format phone number to start with +254
        let formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
        if (formattedPhone.startsWith('+0')) formattedPhone = `+254${formattedPhone.substring(2)}`;
        else if (formattedPhone.startsWith('0')) formattedPhone = `+254${formattedPhone.substring(1)}`;
        else if (formattedPhone.startsWith('254') && !formattedPhone.startsWith('+')) formattedPhone = `+${formattedPhone}`;
        else if (!formattedPhone.startsWith('+254')) {
             // If it's just 7..., add +254
             if (formattedPhone.startsWith('+')) formattedPhone = `+254${formattedPhone.substring(1)}`;
             else formattedPhone = `+254${formattedPhone}`;
        }

        // LipaNa.dev STK Push Request
        // IMPORTANT: We must strictly force HTTPS. If LipaNa sends to HTTP, Vercel returns 308 Redirect 
        // which strips POST bodies and causes webhooks to fail silently.
        // ALSO: Avoid trailing slashes mismatch which can trigger another redirect.
        const host = req.get('host');
        const callbackUrl = process.env.BACKEND_URL ? 
            `${process.env.BACKEND_URL.replace(/\/$/, '')}/api/mpesa/callback` : 
            `https://${host}/api/mpesa/callback`;

        const stkPayload = {
            amount: parseInt(amount),
            phone: formattedPhone,
            callback_url: callbackUrl,
            account_reference: "Course Corner",
            transaction_desc: `Payment for ${category || 'Course Corner'} access`
        };

        // Verified LipaNa.dev STK Push Endpoint
        const endpoint = 'https://api.lipana.dev/v1/transactions/push-stk';
        
        // Debug: Log info about the key (sanitized)
        const keyType = lipanaSecretKey.startsWith('lip_sk_live_') ? 'LIVE' : (lipanaSecretKey.startsWith('lip_sk_test_') ? 'TEST' : 'UNKNOWN');
        console.log(`LipaNa Call | Endpoint: ${endpoint} | Key Type: ${keyType} | Callback: ${callbackUrl}`);
        
        // --- IMPORTANT: Verify callback URL is reachable ---
        if (callbackUrl.includes('localhost') || callbackUrl.includes('127.0.0.1')) {
            console.warn('⚠️ WARNING: Callback URL is local. LipaNa will NOT be able to reach your server.');
        }
        
        const response = await axios.post(endpoint, stkPayload, {
            headers: {
                'x-api-key': lipanaSecretKey,
                'Content-Type': 'application/json'
            }
        });
        
        console.log('✅ LipaNa Response Success');

        // LipaNa.dev returns success, message, and data (transactionId, status, checkoutRequestID)
        const responseData = response.data;
        const checkoutRequestId = responseData.data?.checkoutRequestID || responseData.data?.transactionId || `ln_${Date.now()}`;
        const sessionId = `sess_${checkoutRequestId}_${Date.now()}`;

        if (db) {
            await db.collection('payments').doc(checkoutRequestId).set({
                checkoutRequestId,
                sessionId,
                phoneNumber: formattedPhone,
                amount,
                category,
                referralCode: referralCode || null,
                buyerUid: req.body.buyerUid || null,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                callbackUrl // Save for debugging
            });
        }

        res.json({
            success: true,
            data: {
                checkoutRequestId,
                sessionId,
                amount
            }
        });

    } catch (error) {
        const errorData = error.response?.data;
        console.error('LipaNa STK Push Error Details:', JSON.stringify(errorData || error.message, null, 2));
        
        res.status(500).json({ 
            success: false, 
            message: errorData?.message || error.message || 'Failed to initiate M-Pesa payment.',
            debug: errorData || null
        });
    }
});



// 2. STK Push Callback (Webhook from M-Pesa/LipaNa)
app.post('/api/mpesa/callback', async (req, res) => {
    // Extensive logging for debugging
    console.log('--- Received M-Pesa Callback ---');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));

    try {
        let body = req.body;
        
        // If body is a string (due to Content-Type issues), parse it
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch(e) { console.error('Failed to parse string body'); }
        }

        // --- Handle Payout Webhooks ---
        // If LipaNa sends payout events to this same URL, handle them silently
        if (body.event && body.event.startsWith('payout.')) {
            console.log(`ℹ️ Received Payout Event: ${body.event}`);
            return res.status(200).send('OK');
        }

        // Handle various payload shapes (Safaricom vs LipaNa vs Direct)
        // Check for nested data object first (what LipaNa currently sends)
        let callbackData = body?.Body?.stkCallback || body?.stkCallback || body?.data || body;
        
        // Special case: if it's flat but has transaction_id, it might be the data we need
        if (!callbackData.transactionId && !callbackData.transaction_id && body.transaction_id) {
            callbackData = body;
        }

        // --- DEBUG: Save the raw webhook to Firestore ---
        if (db) {
            try {
                await db.collection('webhook_logs').add({
                    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
                    body: body,
                    query: req.query
                });
            } catch (e) { console.error('Failed to log webhook', e); }
        }

        // LipaNa might send its own flat format without a ResultCode, using 'status' instead
        const hasResultCode = callbackData.ResultCode !== undefined || callbackData.resultCode !== undefined || callbackData.result_code !== undefined;
        const hasStatus = callbackData.status !== undefined;

        if (!callbackData || (!hasResultCode && !hasStatus)) {
            console.error('❌ Invalid callback payload structure:', JSON.stringify(body));
            return res.status(400).send('Invalid payload structure. Ensure you are sending JSON with status or ResultCode.');
        }

        // Standardize the result
        let isSuccess = false;
        let resultCode = 'UNKNOWN';
        let resultDesc = callbackData.ResultDesc || callbackData.resultDesc || callbackData.result_description || callbackData.message || (callbackData.status === 'success' ? 'Success' : 'Failed');
        let checkoutRequestId = callbackData.CheckoutRequestID || callbackData.checkoutRequestID || callbackData.checkoutRequestId || callbackData.transactionId || callbackData.transaction_id || callbackData.reference || body?.transactionId;

        // Force convert checkoutRequestId to string if it exists
        if (checkoutRequestId) checkoutRequestId = String(checkoutRequestId);

        if (hasResultCode) {
            resultCode = callbackData.ResultCode !== undefined ? callbackData.ResultCode : (callbackData.resultCode !== undefined ? callbackData.resultCode : callbackData.result_code);
            isSuccess = parseInt(resultCode) === 0 || resultCode === '0000' || callbackData.status === 'success' || callbackData.status === 'completed';
        } else if (hasStatus) {
            resultCode = callbackData.status;
            isSuccess = (callbackData.status === 'Success' || callbackData.status === 'completed' || callbackData.status === 'successful' || callbackData.status === 'success');
        }

        console.log(`Processing callback for: ${checkoutRequestId} | Success? ${isSuccess} | Result: ${resultCode}`);

        if (!db) {
            console.error('❌ Firestore not initialized. Cannot save callback.');
            return res.status(500).send('Database Error');
        }
        
        if (!checkoutRequestId) {
            console.error('❌ Missing checkoutRequestId in webhook');
            return res.status(400).send('Missing ID');
        }

        const paymentRef = db.collection('payments').doc(checkoutRequestId);
        const paymentDoc = await paymentRef.get();

        if (paymentDoc.exists) {
            const currentData = paymentDoc.data();
            if (currentData.status === 'completed') {
                console.log(`ℹ️ Callback ignored for already completed payment: ${checkoutRequestId}`);
                return res.send('OK');
            }
        } else {
            console.warn(`⚠️ Callback received for unknown checkout: ${checkoutRequestId}`);
            // We still return OK to Safaricom/LipaNa to stop retries
            return res.send('OK');
        }

        if (isSuccess) {
            // Success
            const metadata = callbackData.CallbackMetadata?.Item || callbackData.metadata || callbackData || [];
            let mpesaReceiptNumber = callbackData.mpesaReceiptNumber || callbackData.MpesaReceiptNumber || callbackData.transaction_id || callbackData.transactionId;
            let amount = callbackData.amount || callbackData.Amount;
            let phoneNumber = callbackData.phoneNumber || callbackData.PhoneNumber || callbackData.phone;

            if (Array.isArray(metadata)) {
                metadata.forEach(item => {
                    const name = item.Name || item.name;
                    const value = item.Value || item.value;
                    if (name === 'MpesaReceiptNumber') mpesaReceiptNumber = value;
                    if (name === 'Amount') amount = value;
                    if (name === 'PhoneNumber') phoneNumber = value;
                });
            } else if (typeof metadata === 'object' && !mpesaReceiptNumber) {
                mpesaReceiptNumber = metadata.MpesaReceiptNumber || metadata.mpesaReceiptNumber || metadata.transaction_id || metadata.transactionId;
                amount = metadata.Amount || metadata.amount;
                phoneNumber = metadata.PhoneNumber || metadata.phoneNumber || metadata.phone;
            }

            const paymentData = paymentDoc.data();
            const referralCode = paymentData.referralCode;
            const paidAmount = amount || paymentData.amount;

            await paymentRef.update({
                status: 'completed',
                mpesaCode: mpesaReceiptNumber || 'UNKNOWN',
                paidAmount: paidAmount,
                resultDesc: resultDesc,
                completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Payment successful! Receipt: ${mpesaReceiptNumber}`);

            // --- Referral Commission Logic ---
            if (referralCode && db) {
                try {
                    console.log(`🔍 Processing referral commission for code: ${referralCode}`);
                    // 1. Find the referral record
                    const codeDoc = await db.collection('referralCodes').doc(referralCode.toUpperCase()).get();
                    
                    if (codeDoc.exists) {
                        const codeData = codeDoc.data();
                        const referrerId = codeData.userId;
                        const commission = Math.floor(paidAmount * 0.12); // 12% commission

                        console.log(`💰 Crediting KES ${commission} to referrer: ${referrerId}`);

                        // 2. Update referralCodes record
                        await db.collection('referralCodes').doc(referralCode.toUpperCase()).update({
                            totalReferrals: admin.firestore.FieldValue.increment(1),
                            paidReferrals: admin.firestore.FieldValue.increment(1),
                            totalEarnings: admin.firestore.FieldValue.increment(commission),
                            pendingPayout: admin.firestore.FieldValue.increment(commission),
                            lastReferralAt: admin.firestore.FieldValue.serverTimestamp()
                        });

                        // 3. Update the referrer's user document
                        await db.collection('users').doc(referrerId).update({
                            referralCount: admin.firestore.FieldValue.increment(1),
                            referralPaidCount: admin.firestore.FieldValue.increment(1),
                            referralEarnings: admin.firestore.FieldValue.increment(commission),
                            referralPending: admin.firestore.FieldValue.increment(commission)
                        });

                        console.log(`✅ Referral commission credited successfully`);
                    } else {
                        console.warn(`⚠️ Referral code ${referralCode} not found in referralCodes collection`);
                    }
                } catch (refError) {
                    console.error('❌ Error processing referral commission:', refError);
                }
            }
        } else {
            // Failed
            await paymentRef.update({
                status: 'failed',
                resultCode: resultCode,
                resultDesc: resultDesc,
                failedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`❌ Payment failed: ${resultDesc} (Code: ${resultCode})`);
        }

        res.send('OK'); 

    } catch (error) {
        console.error('❌ Callback CRITICAL error:', error);
        res.status(500).send('Internal Error');
    }
});

// 2.5 Query Status from LipaNa directly (Fallback if callback is slow)
app.post('/api/mpesa/query', async (req, res) => {
    try {
        const { sessionId, checkoutRequestId } = req.body;
        if (!sessionId && !checkoutRequestId) {
            return res.status(400).json({ success: false, message: 'Session or Checkout ID required' });
        }

        if (!db) return res.status(500).json({ success: false, message: 'DB not initialized' });

        let paymentDoc, docId;
        if (checkoutRequestId) {
            docId = checkoutRequestId;
            paymentDoc = await db.collection('payments').doc(checkoutRequestId).get();
        } else {
            const snap = await db.collection('payments').where('sessionId', '==', sessionId).limit(1).get();
            if (!snap.empty) {
                paymentDoc = snap.docs[0];
                docId = paymentDoc.id;
            }
        }

        if (!paymentDoc || !paymentDoc.exists) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        const data = paymentDoc.data();
        
        // If already completed in our DB, just return that
        if (data.status === 'completed') {
            return res.json({ success: true, data: { status: 'completed', mpesaCode: data.mpesaCode } });
        }

        // If not completed, rely entirely on the webhook callback.
        // The direct LipaNa status query is not supported on this endpoint and causes 404s.
        res.json({ success: true, data: { status: data.status, resultDesc: data.resultDesc } });

    } catch (error) {
        console.error('General Query Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2.6 Verify by Mpesa Code (Manual Verification)
app.post('/api/mpesa/verify-mpesa-code', async (req, res) => {
    try {
        const { mpesaCode, category } = req.body;
        if (!mpesaCode) return res.status(400).json({ success: false, message: 'M-Pesa code required' });

        if (!db) return res.status(500).json({ success: false, message: 'DB not initialized' });

        // Search for completed payment with this code
        const snap = await db.collection('payments')
            .where('mpesaCode', '==', mpesaCode.trim().toUpperCase())
            .get();

        if (snap.empty) {
            console.log(`❌ No payment found for code: ${mpesaCode}`);
            return res.status(404).json({ success: false, message: 'M-Pesa code not found or not yet processed. If you just paid, wait 10 seconds and try again.' });
        }

        // Find the one that matches this category or just the latest one
        const paymentDoc = snap.docs[0];
        const payment = paymentDoc.data();
        console.log(`✅ Found payment for manual code: ${mpesaCode} (Amount: ${payment.amount})`);
        
        res.json({
            success: true,
            data: {
                status: payment.status,
                category: payment.category,
                amount: payment.amount,
                phoneNumber: payment.phoneNumber || payment.phone,
                id: paymentDoc.id
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Poll Status Route (Frontend checks this)
app.get('/api/mpesa/status', async (req, res) => {
    // Disable caching for status checks
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    try {
        const { sessionId, checkoutRequestId } = req.query;

        if (!db) {
            return res.status(500).json({ success: false, message: 'Database not initialized' });
        }

        let paymentDoc;
        if (checkoutRequestId) {
             paymentDoc = await db.collection('payments').doc(checkoutRequestId).get();
        } else if (sessionId) {
            const snapshot = await db.collection('payments').where('sessionId', '==', sessionId).limit(1).get();
            if (!snapshot.empty) paymentDoc = snapshot.docs[0];
        }

        if (!paymentDoc || !paymentDoc.exists) {
            return res.status(404).json({ success: false, message: 'Payment session not found' });
        }

        const data = paymentDoc.data();
        
        res.json({
            success: true,
            data: {
                status: data.status,
                resultDesc: data.resultDesc || null,
                amount: data.amount,
                category: data.category,
                mpesaCode: data.mpesaCode || null
            }
        });

    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ success: false, message: 'Server error checking status' });
    }
});

// 4. Access Control Routes
app.post('/api/payment/has-access', async (req, res) => {
    try {
        const { sessionId, category } = req.body;
        if (!sessionId) return res.json({ hasAccess: false });

        if (!db) return res.status(500).json({ success: false, message: 'DB not initialized' });

        const snap = await db.collection('payments')
            .where('sessionId', '==', sessionId)
            .where('status', '==', 'completed')
            .limit(1)
            .get();

        if (snap.empty) return res.json({ hasAccess: false });

        res.json({ success: true, hasAccess: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/payment/approve', async (req, res) => {
    try {
        const { sessionId } = req.body;
        // This is a placeholder for final approval / token generation
        res.json({ 
            success: true, 
            data: { 
                accessToken: `at_${Date.now()}`,
                expiresAt: Date.now() + (24 * 60 * 60 * 1000) 
            } 
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// Health Check & Keep-Alive Ping
app.get('/', (req, res) => {
    res.send('Course Corner Backend is running.');
});

// Lightweight ping endpoint - called by frontend to pre-warm server before payment
app.get('/api/ping', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
});


// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
