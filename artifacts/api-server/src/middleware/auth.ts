import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { pool } from "@workspace/db";
import { hashToken, publicUser, type AuthUser, type Role } from "../db";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.sws_session as string | undefined;
    if (!token) return next();
    const result = await pool.query(
      `SELECT u.*, z.name AS zone_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN zones z ON z.id = u.zone_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [hashToken(token)],
    );
    if (result.rows[0] && result.rows[0].status === "active") {
      req.user = publicUser(result.rows[0]);
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
    [hashToken(token), userId],
  );
  return token;
}

export async function destroySession(token: string | undefined) {
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}