import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const SECRET = process.env.JWT_SECRET || 'secret';

function extractToken(req) {
  // Prefer Authorization: Bearer <token> for mobile apps (Flutter)
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (auth && typeof auth === 'string') {
    const lower = auth.toLowerCase();
    if (lower.startsWith('bearer ')) {
      return auth.slice(7).trim();
    }
  }
  // Fallback to cookie for existing web flows
  if (req.cookies?.token)
    return req.cookies.token;

  return null;
}

export function requireAuth(req, res, next) {
  const t = extractToken(req);
  if (!t)
    return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(t, SECRET);
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

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' });
}