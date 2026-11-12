# Course Corner Backend

This is the Node.js server for the Course Corner application, handling M-Pesa integration and Firebase Admin tasks.

## Setup
1. Upload this folder to a Private GitHub repository.
2. Deploy to Vercel.
3. Add environment variables in Vercel settings (see `.env.example`).
4. Ensure `firebase-service-account.json` is present in the root.

## API Endpoints
- `POST /api/mpesa/stkpush`: Initiate M-Pesa payment.
- `POST /api/mpesa/callback`: M-Pesa result callback.
- `GET /api/mpesa/status`: Check payment status.
