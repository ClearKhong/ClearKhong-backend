// src/routes/notifications.js
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// 1) ดึง noti ทั้งหมด
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT 
        n.id,
        n.message,
        n.created_at,
        n.read,
        n.post_id,
        p.title AS post_title,
        CASE 
          WHEN p.image_url IS NULL THEN NULL
          WHEN jsonb_typeof(p.image_url::jsonb) = 'array' THEN 
            CASE 
              WHEN jsonb_array_length(p.image_url::jsonb) > 0 THEN p.image_url::jsonb->>0
              ELSE NULL
            END
          WHEN jsonb_typeof(p.image_url::jsonb) = 'string' THEN p.image_url::text
          ELSE NULL
        END AS post_image
      FROM notifications n
      LEFT JOIN posts p ON n.post_id = p.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      `,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching notifications:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2) ดึง "ประวัติเหรียญ" จาก noti (สำคัญอันนี้)
router.get('/history', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `
      SELECT 
        id,
        message,
        created_at
      FROM notifications
      WHERE user_id = $1
        AND (
          message LIKE '%หักโทเคน % tokens%'   -- โปรโมท / อนุมัติแล้วหัก 10
          OR message LIKE 'ซื้อ % tokens สำเร็จ' -- ซื้อเหรียญ
        )
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const rows = r.rows.map((row) => {
      const msg = row.message || '';
      let amount = 0;
      let type = 'expanse';

      // ซื้อ 100 tokens สำเร็จ
      if (msg.startsWith('ซื้อ ') && msg.endsWith(' tokens สำเร็จ')) {
        const m = msg.match(/ซื้อ\s+(\d+)\s+tokens/);
        amount = m ? Number(m[1]) : 0;
        type = 'income';
      } else if (msg.includes('หักโทเคน')) {
        // โปรโมท / อนุมัติโพสต์
        const m = msg.match(/หักโทเคน\s+(\d+)\s+tokens/);
        amount = m ? -Number(m[1]) : 0;
        type = 'expanse';
      }

      return {
        id: row.id,
        message: row.message,
        created_at: row.created_at,
        amount,
        type,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error('❌ tokens/history error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3) mark read ทั้งหมด
router.post('/read-all', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE notifications 
       SET read = true 
       WHERE user_id = $1 AND read = false
       RETURNING id`,
      [req.user.id]
    );
    res.json({ ok: true, count: result.rows.length });
  } catch (err) {
    console.error('❌ Error marking all as read:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4) mark read รายตัว
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE notifications 
       SET read = true 
       WHERE id = $1 AND user_id = $2
       RETURNING id, read`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ ok: true, notification: result.rows[0] });
  } catch (err) {
    console.error('❌ Error marking as read:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
