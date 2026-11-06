import type { Request, Response, NextFunction } from "express";
import { getAdminApiKey } from "../config/env.js";

/**
 * Protects administrative endpoints against unrestricted public access.
 *
 * Security & Verification:
 * - Checks `x-admin-key` header or `Authorization: Bearer <key>`.
 * - When ADMIN_API_KEY is configured in the environment:
 *     Requires an exact match; returns 401 Unauthorized on mismatch/absence.
 * - When ADMIN_API_KEY is not configured:
 *     In production: returns 500 to prevent insecure exposure.
 *     In test/development: permits access for local developer convenience.
 */
export function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configuredKey = getAdminApiKey();

  const authHeader = req.headers.authorization;
  const bearerKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : undefined;
  const headerKey = (req.headers["x-admin-key"] as string | undefined)?.trim();
  const providedKey = headerKey ?? bearerKey;

  if (configuredKey) {
    if (!providedKey || providedKey !== configuredKey) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Valid administrator API key is required to access dead-letter resources",
        },
      });
      return;
    }
  } else if (process.env.NODE_ENV === "production") {
    res.status(500).json({
      error: {
        code: "SERVER_MISCONFIGURATION",
        message: "ADMIN_API_KEY must be configured in production environment",
      },
    });
    return;
  }

  next();
}
