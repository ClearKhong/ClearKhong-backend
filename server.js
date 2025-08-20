import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter from './src/routes/auth.js';
import postsRouter from './src/routes/posts.js';
import adminRouter from './src/routes/admin.js';
import tokensRouter from './src/routes/tokens.js';
import profileRouter from './src/routes/profile.js';
import tradesRouter from './src/routes/trades.js';
import commentsRouter from './src/routes/comments.js';
import notifsRouter from './src/routes/notifs.js';
import reportsRouter from './src/routes/reports.js';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const allowed = [process.env.ORIGIN || 'http://127.0.0.1:5500', 'http://localhost:5500'];
app.use(cors({ origin: allowed, credentials: true }));
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Swagger UI
const swaggerDoc = YAML.load(path.join(__dirname, 'swagger', 'openapi.yaml'));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

app.use('/uploads', express.static(path.join(__dirname,'uploads')));
app.get('/health',(req,res)=>res.json({ok:true}));
app.use('/api/auth', authRouter);
app.use('/api/posts', postsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api/profile', profileRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/notifs', notifsRouter);
app.use('/api/reports', reportsRouter);
const PORT=process.env.PORT||4000; app.listen(PORT,()=>console.log('✅ Backend http://127.0.0.1:'+PORT));