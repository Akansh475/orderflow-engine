import type { Request, Response, NextFunction } from "express";
import { productService } from "./product.service.js";

export const productController = {
  async getAll(_req: Request, res: Response, next: NextFunction) {
    try {
      const products = await productService.getAllProducts();
      res.status(200).json({ data: products });
    } catch (error) {
      next(error);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const product = await productService.getProductById(
        req.params.id as string,
      );
      res.status(200).json({ data: product });
    } catch (error) {
      next(error);
    }
  },
  async create(req: Request, res: Response, next: NextFunction) {
  try {
    const product = await productService.createProduct(req.body);

    res.status(201).json({ data: product });
  } catch (error) {
    next(error);
  }
},
};
