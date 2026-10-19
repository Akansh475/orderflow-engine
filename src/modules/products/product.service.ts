import { productRepository } from "./product.repository.js";
import { createProductSchema } from "./product.validation.js";

export const productService = {
  async getAllProducts() {
    return productRepository.findAll();
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