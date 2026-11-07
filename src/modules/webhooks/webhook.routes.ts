import { Router } from "express";
import { webhookController } from "./webhook.controller.js";
import { adminAuthMiddleware } from "../../middleware/admin-auth.middleware.js";

const router = Router();

// All webhook management endpoints require administrative authorization
router.use(adminAuthMiddleware);

router.post("/", webhookController.create);
router.get("/", webhookController.list);
router.get("/:id", webhookController.getById);
router.patch("/:id", webhookController.update);
router.delete("/:id", webhookController.delete);

export default router;
