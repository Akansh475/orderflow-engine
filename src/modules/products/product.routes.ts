import { Router } from "express";
import { productController } from "./product.controller.js";

const router = Router();

router.get("/", productController.getAll);
router.get("/:id", productController.getById);
router.post("/", productController.create);

export default router;
