import { productRepository } from "./product.repository.js";

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
};
