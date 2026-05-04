// ══════════════════════════════════════════════
//  FanWar — Razorpay Payment Backend
//  Node.js + Express
// ══════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const Razorpay = require('razorpay');
const crypto   = require('crypto');
const cors     = require('cors');

const app = express();
app.use(express.json());

// ── CORS — sirf apni site se allow karo ──
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow if no origin (e.g. Postman, server-to-server) OR origin is in whitelist
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS blocked: ' + origin));
    }
  }
}));

// ── Razorpay Instance ──
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── Coin Packs (same as frontend) ──
const COIN_PACKS = {
  p1: { coins: 100,  bonus: 0,   price: 20,  label: 'Starter'  },
  p2: { coins: 250,  bonus: 10,  price: 45,  label: 'Popular'  },
  p3: { coins: 600,  bonus: 50,  price: 100, label: 'Pro'       },
  p4: { coins: 1400, bonus: 200, price: 200, label: 'Champion' },
};

// ════════════════════════════════════════
//  POST /api/create-order
// ════════════════════════════════════════
app.post('/api/create-order', async (req, res) => {
  const { packId, userId } = req.body;

  const pack = COIN_PACKS[packId];
  if (!pack) return res.status(400).json({ error: 'Invalid pack ID' });

  try {
    const order = await razorpay.orders.create({
      amount:   pack.price * 100,
      currency: 'INR',
      receipt:  `fanwar_${userId}_${packId}_${Date.now()}`,
      notes:    { packId, userId, coins: pack.coins, bonus: pack.bonus, label: pack.label },
    });

    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      packId,
      coins:    pack.coins + pack.bonus,
      label:    pack.label,
      price:    pack.price,
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ error: 'Order creation failed' });
  }
});

// ════════════════════════════════════════
//  POST /api/verify-payment
//  Signature verify + Firestore mein coins credit
// ════════════════════════════════════════
app.post('/api/verify-payment', async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    packId,
    userId,   // Firebase uid
  } = req.body;

  // ── 1. Signature Verify ──
  const body     = razorpay_order_id + '|' + razorpay_payment_id;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expected !== razorpay_signature) {
    console.warn('❌ Invalid signature — possible tampering!', { userId, packId });
    return res.status(400).json({ success: false, error: 'Invalid signature' });
  }

  // ── 2. Pack check ──
  const pack = COIN_PACKS[packId];
  if (!pack) return res.status(400).json({ success: false, error: 'Pack not found' });

  const totalCoins = pack.coins + pack.bonus;

  // ── 3. Firestore mein coins add karo (Firebase Admin SDK) ──
  try {
    const admin = require('firebase-admin');

    // Initialize only once
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }

    const db = admin.firestore();

    // User doc mein warCoins increment karo
    await db.doc(`users/${userId}`).set(
      { warCoins: admin.firestore.FieldValue.increment(totalCoins) },
      { merge: true }
    );

    // Transaction log save karo (optional but good practice)
    await db.collection('transactions').add({
      userId,
      packId,
      packLabel:  pack.label,
      coins:      totalCoins,
      amountPaid: pack.price,
      paymentId:  razorpay_payment_id,
      orderId:    razorpay_order_id,
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Payment verified | User: ${userId} | +${totalCoins} coins | ${razorpay_payment_id}`);
    res.json({ success: true, coins: totalCoins, packLabel: pack.label });

  } catch (err) {
    console.error('Firestore update error:', err);
    res.status(500).json({ success: false, error: 'Coins credit failed — contact support' });
  }
});

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'FanWar Payment Server running ✅' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 FanWar Server running on port ${PORT}`);
  console.log(`   Razorpay Key: ${process.env.RAZORPAY_KEY_ID || '⚠️ Not set'}`);
  console.log(`   Allowed Origins: ${process.env.ALLOWED_ORIGINS || '⚠️ Not set — all blocked!'}\n`);
});
