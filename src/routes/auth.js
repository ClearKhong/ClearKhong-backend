import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import dotenv from 'dotenv';
dotenv.config();
const router=Router();
router.post('/register', async (req,res)=>{ try{ const {username,password,shopName,phone,email}=req.body;
  const phoneOk = !phone || /^\d{10}$/.test(String(phone));
  const emailOk = !email || String(email).includes('@');
  if (!phoneOk)
    return res.status(400).json({ error: 'Phone must be 10 digits' });
  if (!emailOk)
    return res.status(400).json({ error: 'Email must contain @' });
  if (!username || !password)
    return res.status(400).json({ error: 'Please fill in username & password' });
  const ex = await query('SELECT 1 FROM users WHERE username=$1', [username]);
  if (ex.rowCount)
    return res.status(400).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  const r = await query(`INSERT INTO users (username,password_hash,role,shop_name,phone,email,tokens) VALUES ($1,$2,'user',$3,$4,$5,100) RETURNING id`, [username, hash, shopName || null, phone || null, email || null]);
  const token=jwt.sign({id:r.rows[0].id,role:'user'},process.env.JWT_SECRET||'secret',{expiresIn:'7d'});
  res.cookie('token',token,{httpOnly:true,sameSite:'lax',secure:false,maxAge:7*24*3600*1000}); 
  res.json({ ok: true });
} catch (e) {
  res.status(500).json({ error: 'server error' });
}
});
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const r = await query('SELECT id,password_hash,role,is_active FROM users WHERE username=$1', [username]);
  if (!r.rowCount || !r.rows[0].is_active)
    return res.status(400).json({ error: 'User not found or suspended' });
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok)
      return res.status(400).json({ error: 'Incorrect password' });
  const token=jwt.sign({id:r.rows[0].id,role:r.rows[0].role},process.env.JWT_SECRET||'secret',{expiresIn:'7d'});
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7 * 24 * 3600 * 1000 });
    res.json({ ok: true, role: r.rows[0].role });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});
router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});
export default router;