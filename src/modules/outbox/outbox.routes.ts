import { Router } from "express";
import { outboxController } from "./outbox.controller.js";
import { adminAuthMiddleware } from "../../middleware/admin-auth.middleware.js";

const router = Router();

// All dead-letter inspection and replay endpoints require administrative authorization
router.use(adminAuthMiddleware);

router.get("/dead-letter", outboxController.listDeadLetter);
router.get("/dead-letter/:id", outboxController.getDeadLetterById);
router.post("/dead-letter/:id/replay", outboxController.replay);

export default router;
