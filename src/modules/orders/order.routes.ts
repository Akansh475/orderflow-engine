import { Router } from "express";
import { orderController } from "./order.controller.js";

const router = Router();

router.get("/", orderController.list);
router.post("/", orderController.create);
router.patch("/:id/cancel", orderController.cancel);
router.get("/:id", orderController.getById);
router.post("/:id/pay", orderController.pay);
router.post("/:id/fulfill", orderController.fulfill);
router.get("/:id/payments", orderController.getPayments);
router.get("/:id/history", orderController.getHistory);
router.post("/:id/expire", orderController.expire);
router.post("/admin/expire-stale", orderController.expireStale);
router.post("/admin/recover-stuck-payments", orderController.recoverStuckPayments);
router.get("/admin/low-stock", orderController.getLowStockInventory);
router.post("/admin/restock", orderController.restockInventory);
export default router;