import { Router } from "express";
import { orderController } from "./order.controller.js";

const router = Router();

router.post("/", orderController.create);
router.patch("/:id/cancel", orderController.cancel);

export default router;