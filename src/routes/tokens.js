import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * ✅ เติมเหรียญ (tokens) ให้กับบัญชีผู้ใช้
 * ใช้แพ็กเกจ: 10, 20, 50, 100, 300, 500
 * ล็อกอินเท่านั้น
 */
router.post('/confirm', requireAuth, async (req, res) => {
  const amount = Number(req.body.amount || 0);

  // ✅ ใช้ชุดเดียวกับฝั่งแอป
  const ALLOWED = [10, 20, 50, 100, 300, 500];

  if (!ALLOWED.includes(amount)) {
    return res.status(400).json({ error: 'Incorrect package' });
  }

  // ดึงยอดปัจจุบัน
  const r = await query(
    `SELECT tokens FROM users WHERE id = $1`,
    [req.user.id]
  );

  const current = r.rows[0]?.tokens || 0;

  // จำกัดยอดสูงสุด
  if (current + amount > 1000) {
    return res.status(400).json({ error: 'Max tokens 1000' });
  }

  // อัปเดตเหรียญ
  const r2 = await query(
    `UPDATE users 
        SET tokens = tokens + $1 
      WHERE id = $2 
      RETURNING tokens`,
    [amount, req.user.id]
  );

  // ใส่ noti ด้วย (ถ้าอยากผูก post_id ทีหลังค่อยเพิ่มคอลัมน์)
  await query(
    `INSERT INTO notifications (user_id, message)
     VALUES ($1, $2)`,
    [req.user.id, `ซื้อ ${amount} tokens สำเร็จ`]
  );

  res.json({
    ok: true,
    tokens: r2.rows[0].tokens,
    added: amount,
  });
});

export default router;
