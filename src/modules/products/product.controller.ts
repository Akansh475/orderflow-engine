import type { Request, Response, NextFunction } from "express";
import { productService } from "./product.service.js";

export const productController = {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await productService.getAllProducts(req.query);
      res.status(200).json(result);
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

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const product = await productService.updateProduct(
        req.params.id as string,
        req.body,
      );
      res.status(200).json({ data: product });
    } catch (error) {
      next(error);
    }
  },

  async replace(req: Request, res: Response, next: NextFunction) {
    try {
      const product = await productService.replaceProduct(
        req.params.id as string,
        req.body,
      );
      res.status(200).json({ data: product });
    } catch (error) {
      next(error);
    }
  },

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await productService.deleteProduct(req.params.id as string);
      res.status(200).json({ message: "Product deleted successfully" });
    } catch (error) {
      next(error);
    }
  },
};
