import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
const avatarDir = path.join(process.cwd(), 'uploads', 'avatars');
if (!fs.existsSync(avatarDir))
  fs.mkdirSync(avatarDir, { recursive: true });
const storage = multer.diskStorage({ destination: (r, f, cb) => cb(null, avatarDir), filename: (r, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(f.originalname)) });
const upload = multer({ storage });

// ดึงโปรไฟล์สาธารณะของผู้ใช้คนอื่น พร้อมโพสต์ล่าสุด (ไม่ต้องล็อกอิน)
router.get('/public/:id', async (req, res) => {
  const uid = req.params.id;
  const u = await query(
    `SELECT id, username, name, phone, email, fackebook, line, bio, profile_image_url 
       FROM users WHERE id=$1`,
    [uid]
  );
  if (!u.rowCount)
    return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

  const posts = await query(
    `SELECT id, title, status, created_at
       FROM posts
      WHERE user_id=$1
      ORDER BY created_at DESC`,
    [uid]
  );

  res.json({ user: u.rows[0], recentPosts: posts.rows });
});

// ดึงข้อมูลโปรไฟล์ของตัวเอง (ต้องล็อกอิน)
router.get('/me', requireAuth, async (req, res) => {
  const r = await query(
    `SELECT id, username, name, phone, email, fackebook, line, address, bio, 
            profile_image_url, tokens, role, 
            payment_account_name, payment_qr_code_url, 
            shipping_name, shipping_phone
       FROM users WHERE id=$1`,
    [req.user.id]
  );
  res.json(r.rows[0]);
});

// อัปเดตโปรไฟล์ของตัวเอง (ต้องล็อกอิน อัปโหลดรูปได้)
router.put('/me', requireAuth, upload.single('profileImage'), async (req, res) => {
  const { name, email, phone, fackebook, line, address, bio, 
          payment_account_name, shipping_name, shipping_phone } = req.body;

  const phoneOk = !phone || /^\d{10}$/.test(String(phone));
  const shippingPhoneOk = !shipping_phone || /^\d{10}$/.test(String(shipping_phone));
  const emailOk = !email || String(email).includes('@');
  if (!phoneOk)
    return res.status(400).json({ error: 'เบอร์โทรศัพท์ต้องมี 10 หลัก' });
  if (!shippingPhoneOk)
    return res.status(400).json({ error: 'เบอร์โทรศัพท์สำหรับจัดส่งพัสดุต้องมี 10 หลัก' });
  if (!emailOk)
    return res.status(400).json({ error: 'อีเมลต้องมี @' });

  const img = req.file ? ('/uploads/avatars/' + req.file.filename) : null;

  const r = await query(
    `UPDATE users 
        SET name=COALESCE($2, name),
            phone=COALESCE($3, phone),
            email=COALESCE($4, email),
            address=COALESCE($5, address),
            fackebook=COALESCE($6, fackebook),
            line=COALESCE($7, line),
            bio=COALESCE($8, bio),
            profile_image_url=COALESCE($9, profile_image_url),
            payment_account_name=COALESCE($10, payment_account_name),
            shipping_name=COALESCE($11, shipping_name),
            shipping_phone=COALESCE($12, shipping_phone)
      WHERE id=$1
      RETURNING id, username, name, phone, email, fackebook, line, address, bio, 
                profile_image_url, tokens, role, 
                payment_account_name, payment_qr_code_url, 
                shipping_name, shipping_phone`,
    [
      req.user.id,
      name || null,
      phone || null,
      email || null,
      address || null,
      fackebook || null,
      line || null,
      bio || null,
      img,
      payment_account_name || null,
      shipping_name || null,
      shipping_phone || null
    ]
  );

  res.json(r.rows[0]);
});

// ดึงประวัติการใช้งานของตัวเอง (โพสต์, ซื้อ, เทรด) (ต้องล็อกอิน)
// ดึงประวัติการใช้งานของตัวเอง (โพสต์, ซื้อ, เทรด) (ต้องล็อกอิน)
router.get('/history', requireAuth, async (req, res) => {
  const userId = req.user.id;

  // 1) โพสต์ของตัวเอง
  const myPosts = await query(
  `
  SELECT 
    p.id,
    p.title,
    p.status,
    p.promoted,
    p.created_at,
    p.price,
    p.is_sell,
    p.is_trade,
    CASE 
      WHEN p.image_url IS NULL OR p.image_url = '' THEN NULL

      -- กรณีเก็บเป็น JSON array
      WHEN LEFT(p.image_url, 1) = '['
        THEN (p.image_url::jsonb ->> 0)

      -- กรณีเก็บเป็น string เดี่ยว เช่น '/uploads/posts/...'
      ELSE p.image_url
    END AS cover_image
  FROM posts p
  WHERE p.user_id = $1
  ORDER BY p.created_at DESC
  `,
  [userId]
);


  // 2) การซื้อสินค้า (orders) — แถมรูปให้ด้วยเลย เผื่อคุณไปใช้หน้าอื่น
  const myOrders = await query(
    `
    SELECT 
      o.id,
      o.post_id,
      o.amount,
      o.status,
      o.name,
      o.phone,
      o.address,
      o.tracking_number,
      o.created_at,
      p.title,
      p.is_sell,
      p.is_trade,
      p.price AS post_price,
      CASE 
        WHEN p.image_url IS NULL THEN NULL
        WHEN jsonb_typeof(p.image_url::jsonb) = 'array'
          THEN (p.image_url::jsonb ->> 0)
        ELSE NULL
      END AS cover_image
    FROM orders o
    JOIN posts p ON p.id = o.post_id
    WHERE o.buyer_id = $1
    ORDER BY o.created_at DESC
    `,
    [userId]
  );

  // 3) การเสนอเทรด (trades) ของเดิมคุณมีอยู่แล้ว ผมแค่ย้าย userId เข้าไปใช้เฉยๆ
  const myTrades = await query(
    `
    SELECT 
      t.id AS trade_id,
      t.status,
      t.created_at,
      json_agg(json_build_object(
        'post_id', p.id,
        'post_title', p.title
      )) AS posts,
      (
        SELECT json_agg(json_build_object(
          'title', ti.title,
          'description', ti.description,
          'tags', ti.tags,
          'images', ti.image_url
        ))
        FROM trade_items ti
        WHERE ti.trade_id = t.id
      ) AS items
    FROM trades t
    JOIN trade_posts tp ON tp.trade_id = t.id
    JOIN posts p ON p.id = tp.post_id
    WHERE t.proposer_id = $1
    GROUP BY t.id
    ORDER BY t.created_at DESC
    `,
    [userId]
  );

  res.json({
    myPosts: myPosts.rows,
    myOrders: myOrders.rows,
    myTrades: myTrades.rows,
  });
});

// อัปโหลด QR Code สำหรับช่องทางการรับเงิน
router.post('/payment-qr', requireAuth, upload.single('qrCode'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'กรุณาอัปโหลดไฟล์ QR Code' });
  }

  const qrUrl = '/uploads/avatars/' + req.file.filename;

  const r = await query(
    `UPDATE users 
        SET payment_qr_code_url=$2
      WHERE id=$1
      RETURNING payment_qr_code_url`,
    [req.user.id, qrUrl]
  );

  res.json({ qr_code_url: r.rows[0].payment_qr_code_url });
});

export default router;