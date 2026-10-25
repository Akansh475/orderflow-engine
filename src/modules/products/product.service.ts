import { productRepository } from "./product.repository.js";
import {
  createProductSchema,
  productQuerySchema,
} from "./product.validation.js";
import { createPaginationMeta } from "../../shared/types.js";

export const productService = {
  async getAllProducts(query: unknown = {}) {
    const params = productQuerySchema.parse(query);
    const { products, total } =
      await productRepository.findPaginatedWithCount(params);

    return {
      data: products,
      pagination: createPaginationMeta(params.page, params.limit, total),
    };
  },

  async getProductById(id: string) {
    const product = await productRepository.findById(id);

    if (!product) {
      throw new Error("Product not found");
    }

    return product;
  },

  async createProduct(input: unknown) {
    const data = createProductSchema.parse(input);

    return productRepository.create(data);
  },
};
