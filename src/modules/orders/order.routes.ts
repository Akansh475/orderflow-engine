import { Router } from "express";
import { orderController } from "./order.controller.js";

const router = Router();

router.post("/", orderController.create);
router.patch("/:id/cancel", orderController.cancel);
router.get("/:id", orderController.getById);
router.post("/:id/pay", orderController.pay);
router.post("/:id/fulfill", orderController.fulfill);
router.get("/:id/history", orderController.getHistory);

export default router;