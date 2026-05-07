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

// ── Firebase Admin (initialize once) ──
function getDb() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

// ════════════════════════════════════════
//  COIN PACKS — WarCoins khareedne ke liye
//  100 coins  = Rs.19
//  250 coins  = Rs.45
//  600 coins  = Rs.99
//  1400 coins = Rs.199
// ════════════════════════════════════════
const COIN_PACKS = {
  p1: { coins: 100,  price: 19,  label: 'Starter'  },
  p2: { coins: 250,  price: 45,  label: 'Popular'  },
  p3: { coins: 600,  price: 99,  label: 'Pro'       },
  p4: { coins: 1400, price: 199, label: 'Champion'  },
};

// ════════════════════════════════════════
//  WITHDRAW PACKS — WarCoins → Real Money
//  1000 coins = Rs.100
//  1200 coins = Rs.130
//  1800 coins = Rs.180
//  3000 coins = Rs.350
// ════════════════════════════════════════
const WITHDRAW_PACKS = {
  w1: { coins: 1000, payout: 100, label: 'Basic'    },
  w2: { coins: 1200, payout: 130, label: 'Standard' },
  w3: { coins: 1800, payout: 180, label: 'Premium'  },
  w4: { coins: 3000, payout: 350, label: 'Elite'    },
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
      notes:    { packId, userId, coins: pack.coins, label: pack.label },
    });
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, packId, coins: pack.coins, label: pack.label, price: pack.price, razorpayKeyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ error: 'Order creation failed' });
  }
});

// ════════════════════════════════════════
//  POST /api/verify-payment
// ════════════════════════════════════════
app.post('/api/verify-payment', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, packId, userId } = req.body;

  const body     = razorpay_order_id + '|' + razorpay_payment_id;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ success: false, error: 'Invalid signature' });
  }

  const pack = COIN_PACKS[packId];
  if (!pack) return res.status(400).json({ success: false, error: 'Pack not found' });

  try {
    const admin = require('firebase-admin');
    const db    = getDb();

    await db.doc(`users/${userId}`).set(
      { warCoins: admin.firestore.FieldValue.increment(pack.coins) },
      { merge: true }
    );

    await db.collection('transactions').add({
      type: 'credit', userId, packId, packLabel: pack.label,
      coins: pack.coins, amountPaid: pack.price,
      paymentId: razorpay_payment_id, orderId: razorpay_order_id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Coins credited | User: ${userId} | +${pack.coins} coins | Rs.${pack.price}`);
    res.json({ success: true, coins: pack.coins, packLabel: pack.label });
  } catch (err) {
    console.error('Firestore error:', err);
    res.status(500).json({ success: false, error: 'Coins credit failed' });
  }
});

// ════════════════════════════════════════
//  POST /api/withdraw
//  Coins deduct karke withdrawal request save karo
// ════════════════════════════════════════
app.post('/api/withdraw', async (req, res) => {
  const { packId, userId, upiId } = req.body;

  if (!upiId) return res.status(400).json({ success: false, error: 'UPI ID required' });

  const pack = WITHDRAW_PACKS[packId];
  if (!pack) return res.status(400).json({ success: false, error: 'Invalid withdraw pack' });

  try {
    const admin = require('firebase-admin');
    const db    = getDb();

    const userDoc      = await db.doc(`users/${userId}`).get();
    const currentCoins = userDoc.data()?.warCoins || 0;

    if (currentCoins < pack.coins) {
      return res.status(400).json({ success: false, error: `Insufficient coins. You have ${currentCoins}, need ${pack.coins}.` });
    }

    await db.doc(`users/${userId}`).update({
      warCoins: admin.firestore.FieldValue.increment(-pack.coins),
    });

    await db.collection('withdrawals').add({
      userId, packId, packLabel: pack.label,
      coins: pack.coins, payout: pack.payout, upiId,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`💸 Withdraw | User: ${userId} | ${pack.coins} coins -> Rs.${pack.payout} | UPI: ${upiId}`);
    res.json({ success: true, payout: pack.payout, message: `Rs.${pack.payout} will be sent to ${upiId} within 24 hours.` });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ success: false, error: 'Withdraw request failed' });
  }
});

// ── Lists ──
app.get('/api/withdraw-packs', (req, res) => res.json(WITHDRAW_PACKS));
app.get('/api/coin-packs',     (req, res) => res.json(COIN_PACKS));

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'FanWar Payment Server running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n FanWar Server running on port ${PORT}`);
  console.log(`   Razorpay Key: ${process.env.RAZORPAY_KEY_ID || 'Not set'}`);
  console.log(`   Allowed Origins: ${process.env.ALLOWED_ORIGINS || 'Not set'}\n`);
});
