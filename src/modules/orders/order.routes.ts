import { Router } from "express";
import { orderController } from "./order.controller.js";

const router = Router();

router.post("/", orderController.create);

export default router;