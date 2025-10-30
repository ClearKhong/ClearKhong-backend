import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import dotenv from 'dotenv';
dotenv.config();

const router = Router();
const SECRET = process.env.JWT_SECRET || 'secret';

// สมัครสมาชิกใหม่ (Register) — ส่งคืน token ใน JSON สำหรับแอพ และยัง set-cookie ให้เว็บเดิม
router.post('/register', async (req, res) => {
  try {
    const { username, password, phone, email } = req.body;

    const phoneOk = !phone || /^\d{10}$/.test(String(phone));
    const emailOk = !email || String(email).includes('@');
    if (!phoneOk)
      return res.status(400).json({ error: 'เบอร์โทรต้องมี 10 หลัก' });
    if (!emailOk)
      return res.status(400).json({ error: 'อีเมลต้องมี @' });
    if (!username || !password)
      return res.status(400).json({ error: 'ขาดข้อมูล username หรือ password' });

    const exists = await query('SELECT id FROM users WHERE username=$1', [username]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้งานมีอยู่แล้ว' });

    const hash = await bcrypt.hash(password, 10);
    const ins = await query(
      `INSERT INTO users (username, password_hash, role, phone, email, tokens)
       VALUES ($1,$2,'user',$3,$4,100)
       RETURNING id, username, role`,
      [username, hash, phone ?? null, email ?? null]
    );

    const user = ins.rows[0];
    const token = jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '7d' });

    // set-cookie สำหรับเว็บ (คงความเข้ากันได้เดิม)
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 3600 * 1000,
      path: '/'
    });

    // สำคัญสำหรับแอพ: ส่ง token กลับใน JSON
    return res.json({
      ok: true,
      token,
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// เข้าสู่ระบบ (Login) — ส่งคืน token ใน JSON สำหรับแอพ และยัง set-cookie ให้เว็บเดิม
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'ขาดข้อมูล username หรือ password' });

    const r = await query(
      'SELECT id, username, role, password_hash, is_active FROM users WHERE username=$1',
      [username]
    );

    if (!r.rowCount || !r.rows[0].is_active)
      return res.status(400).json({ error: 'ไม่พบผู้ใช้หรือบัญชีถูกระงับ' });

    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok)
      return res.status(400).json({ error: 'รหัสผ่านไม่ถูกต้อง' });

    const user = { id: r.rows[0].id, username: r.rows[0].username, role: r.rows[0].role };
    const token = jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '7d' });

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 3600 * 1000,
      path: '/'
    });

    return res.json({ ok: true, role: user.role, token, user });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ออกจากระบบ (Logout)
router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  return res.json({ ok: true });
});

export default router;