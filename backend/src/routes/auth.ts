import { Router } from "express";
import jwt from "jsonwebtoken";

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = "8h";

// In production replace with a real provider store / hashed passwords.
// Credentials are read from env for simplicity.
const PROVIDER_ID = process.env.PROVIDER_ID ?? "provider";
const PROVIDER_PASSWORD = process.env.PROVIDER_PASSWORD!;

/**
 * POST /api/auth/login
 * Body: { "provider_id": "...", "password": "..." }
 * Returns: { "token": "<JWT>" }
 */
authRouter.post("/login", (req, res) => {
  const { provider_id, password } = req.body as {
    provider_id?: string;
    password?: string;
  };

  if (!provider_id || !password) {
    return res.status(400).json({ error: "provider_id and password are required" });
  }

  if (provider_id !== PROVIDER_ID || password !== PROVIDER_PASSWORD) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ sub: provider_id }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  return res.json({ token });
});
