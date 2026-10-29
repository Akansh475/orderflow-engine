import { Router } from "express";
import { productController } from "./product.controller.js";

const router = Router();

router.get("/", productController.getAll);
router.get("/:id", productController.getById);
router.post("/", productController.create);
router.patch("/:id", productController.update);
router.put("/:id", productController.replace);
router.delete("/:id", productController.delete);

export default router;
