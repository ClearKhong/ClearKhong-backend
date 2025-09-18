import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();
export function requireAuth(req, res, next) {
  const t = req.cookies?.token;
  if (!t)
    return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(t, process.env.JWT_SECRET || 'secret');
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}
export function requireAdmin(req, res, next) {
  if (!req.user)
    return res.status(401).json({ error: 'unauthorized' });
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });
  next();
}